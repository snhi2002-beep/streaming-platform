import { Router, Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { redis } from "../../infrastructure/redis/redis-client.js";
import { env } from "../../config/env.js";
import { REDIS_KEYS } from "../../config/constants.js";
import { AppError } from "../../errors/app-error.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { logger } from "../../infrastructure/logging/logger.js";

export const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-10-28.acacia" as Stripe.LatestApiVersion,
});

export const subscriptionsRouter = Router();

const checkoutSchema = z.object({
  planCode: z.string().min(1),
});

subscriptionsRouter.get("/plans", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { priceAmount: "asc" },
    });
    res.json({ success: true, data: plans });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.post(
  "/checkout",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = checkoutSchema.parse(req.body);
      const plan = await prisma.subscriptionPlan.findUnique({
        where: { code: body.planCode },
      });

      if (!plan || !plan.isActive || !plan.stripePriceId) {
        throw AppError.badRequest("Selected subscription plan is unavailable for billing");
      }

      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
      let stripeCustomerId = user.stripeCustomerId;

      if (!stripeCustomerId) {
        const customer = await stripeClient.customers.create({
          email: user.email,
          metadata: { userId: user.id },
        });
        stripeCustomerId = customer.id;
        await prisma.user.update({
          where: { id: user.id },
          data: { stripeCustomerId },
        });
      }

      const session = await stripeClient.checkout.sessions.create(
        {
          customer: stripeCustomerId,
          mode: "subscription",
          line_items: [{ price: plan.stripePriceId, quantity: 1 }],
          success_url: env.STRIPE_SUCCESS_URL,
          cancel_url: env.STRIPE_CANCEL_URL,
          metadata: {
            userId: user.id,
            planId: plan.id,
          },
        },
        {
          idempotencyKey: `checkout:${user.id}:${plan.id}:${Math.floor(Date.now() / 60000)}`,
        }
      );

      res.json({
        success: true,
        data: { checkoutUrl: session.url, sessionId: session.id },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Raw-body Stripe Webhook Handler with cryptographic signature verification,
 * idempotent event storage, out-of-order protection, and cache invalidation.
 */
export async function stripeWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const signature = req.header("stripe-signature");
  if (!signature) {
    next(AppError.badRequest("Missing Stripe-Signature header"));
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.body as Buffer,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.warn({ err }, "Stripe webhook signature verification failed");
    next(AppError.badRequest("Invalid Stripe webhook signature"));
    return;
  }

  try {
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { providerEventId: event.id },
    });

    if (existingEvent?.processed) {
      res.json({ received: true, duplicate: true });
      return;
    }

    await prisma.webhookEvent.upsert({
      where: { providerEventId: event.id },
      update: {},
      create: {
        provider: "STRIPE",
        providerEventId: event.id,
        eventType: event.type,
        payloadJson: event as unknown as object,
      },
    });

    const eventCreatedTime = new Date(event.created * 1000);

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subObj = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subObj.customer === "string" ? subObj.customer : subObj.customer.id;
      const user = await prisma.user.findUnique({
        where: { stripeCustomerId: customerId },
      });

      if (user) {
        const stripePriceId = subObj.items.data[0]?.price.id;
        const plan = stripePriceId
          ? await prisma.subscriptionPlan.findUnique({ where: { stripePriceId } })
          : null;

        if (plan) {
          const statusMap: Record<string, "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED" | "EXPIRED"> = {
            active: "ACTIVE",
            trialing: "TRIALING",
            past_due: "PAST_DUE",
            canceled: "CANCELED",
            unpaid: "EXPIRED",
          };
          const mappedStatus = statusMap[subObj.status] ?? "INCOMPLETE";

          await prisma.$transaction(async (tx) => {
            const existingSub = await tx.subscription.findUnique({
              where: { stripeSubscriptionId: subObj.id },
            });

            // Guard against out-of-order webhook delivery
            if (existingSub && existingSub.providerUpdatedAt > eventCreatedTime) {
              return;
            }

            const gracePeriodEndsAt =
              mappedStatus === "PAST_DUE"
                ? new Date(Date.now() + env.SUBSCRIPTION_GRACE_PERIOD_DAYS * 86400 * 1000)
                : null;

            await tx.subscription.upsert({
              where: { stripeSubscriptionId: subObj.id },
              update: {
                status: mappedStatus,
                currentPeriodStart: new Date(subObj.current_period_start * 1000),
                currentPeriodEnd: new Date(subObj.current_period_end * 1000),
                cancelAtPeriodEnd: subObj.cancel_at_period_end,
                gracePeriodEndsAt,
                providerUpdatedAt: eventCreatedTime,
              },
              create: {
                userId: user.id,
                planId: plan.id,
                stripeSubscriptionId: subObj.id,
                status: mappedStatus,
                currentPeriodStart: new Date(subObj.current_period_start * 1000),
                currentPeriodEnd: new Date(subObj.current_period_end * 1000),
                cancelAtPeriodEnd: subObj.cancel_at_period_end,
                gracePeriodEndsAt,
                providerUpdatedAt: eventCreatedTime,
              },
            });
          });

          await redis.del(REDIS_KEYS.userEntitlement(user.id));
        }
      }
    }

    await prisma.webhookEvent.update({
      where: { providerEventId: event.id },
      data: { processed: true, processedAt: new Date() },
    });

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}
