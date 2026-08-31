import app from "./app";
import { logger } from "./lib/logger";
import { getBotInviteUrl, startDiscordBot } from "./discord-bot";

app.get("/api/discord/invite", (_req, res) => {
  const inviteUrl = getBotInviteUrl();
  if (!inviteUrl) {
    res.status(503).json({
      error:
        "The Discord bot is not ready yet. Wait for the Discord bot logged in message and try again.",
    });
    return;
  }
  res.json({ inviteUrl });
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startDiscordBot();
});
