import { PrismaClient, BillingInterval, MaturityRating, ContentStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run development seed script in production environment.");
  }

  const permissions = [
    { code: "catalog:write", description: "Create, update, and publish catalog items" },
    { code: "media:upload", description: "Initiate uploads and trigger FFmpeg transcoding" },
    { code: "users:manage", description: "Manage user accounts and roles" },
    { code: "subscriptions:manage", description: "Manage subscription plans and billing" },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: { description: perm.description },
      create: perm,
    });
  }

  const adminRole = await prisma.role.upsert({
    where: { name: "ADMIN" },
    update: {},
    create: { name: "ADMIN", description: "Platform Administrator" },
  });

  await prisma.role.upsert({
    where: { name: "VIEWER" },
    update: {},
    create: { name: "VIEWER", description: "Standard Streaming Viewer" },
  });

  const allPerms = await prisma.permission.findMany();
  for (const perm of allPerms) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: adminRole.id, permissionId: perm.id },
      },
      update: {},
      create: { roleId: adminRole.id, permissionId: perm.id },
    });
  }

  await prisma.subscriptionPlan.upsert({
    where: { code: "FREE_TIER" },
    update: {},
    create: {
      code: "FREE_TIER",
      name: "Free Explorer",
      description: "Ad-free trailers and select non-premium titles in 720p",
      priceAmount: "0.00",
      currency: "USD",
      billingInterval: BillingInterval.MONTHLY,
      trialDays: 0,
      maxConcurrentStreams: 1,
      maxResolutionHeight: 720,
    },
  });

  await prisma.subscriptionPlan.upsert({
    where: { code: "PREMIUM_MONTHLY" },
    update: {},
    create: {
      code: "PREMIUM_MONTHLY",
      name: "Premium HD Monthly",
      description: "Full catalog access in 1080p Full HD on up to 4 concurrent streams",
      priceAmount: "14.99",
      currency: "USD",
      billingInterval: BillingInterval.MONTHLY,
      trialDays: 7,
      maxConcurrentStreams: 4,
      maxResolutionHeight: 1080,
      stripePriceId: "price_dev_premium_monthly",
    },
  });

  const sciFi = await prisma.genre.upsert({
    where: { slug: "sci-fi" },
    update: {},
    create: { name: "Sci-Fi", slug: "sci-fi", description: "Science Fiction & Cyberpunk" },
  });

  await prisma.movie.upsert({
    where: { slug: "orbital-horizon" },
    update: {},
    create: {
      title: "Orbital Horizon",
      slug: "orbital-horizon",
      synopsis: "A deep-space relay engineer uncovers a signal anomaly near Europa.",
      runtimeSeconds: 7320,
      maturityRating: MaturityRating.PG_13,
      status: ContentStatus.PUBLISHED,
      isFeatured: true,
      trendingScore: 98.4,
      requiresPremium: true,
      publishedAt: new Date(),
      genres: {
        create: [{ genreId: sciFi.id }],
      },
    },
  });

  console.log("Development database seeded successfully.");
}

main()
  .catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
