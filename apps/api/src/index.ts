import express, { Request, Response } from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "streaming-platform-api",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/streams", (_req: Request, res: Response) => {
  res.json({
    streams: [
      {
        id: "stream-1",
        title: "Live Coding: Building a Streaming Architecture",
        streamer: "dev_channel",
        status: "live",
        viewers: 142,
      },
      {
        id: "stream-2",
        title: "HLS & DASH Adaptive Bitrate Deep Dive",
        streamer: "media_eng",
        status: "offline",
        viewers: 0,
      },
    ],
  });
});

app.listen(PORT, () => {
  console.log(`[api] Server listening on http://localhost:${PORT}`);
});
