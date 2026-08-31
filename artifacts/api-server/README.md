# Discord Invite Tracker

This service runs the Discord invite tracker and keeps the starter API health endpoint available.

## Features

- Screenshot-style member join embeds with a purple accent, server author row, member username, mention text, member count footer, and the joining member’s PFP on the right.
- Invite-created embeds with the creator’s PFP, invite code, and usage count.
- Persistent invite scores in `data/invites.sqlite`.
- `/invites` to check a member’s successful invite score.
- `/invitechannel` for members with Manage Channels to choose a different log channel for the current run.
- `/invitetest` for members with Manage Channels to post a screenshot-style test card using their own Discord PFP.
- Optional historical log import using `HISTORICAL_LOG_CHANNEL_ID` and `IMPORT_HISTORICAL_LOGS=true`.

## Discord setup

The bot invite must be an OAuth2 URL for the bot application. The screenshot's
`Invalid Form Body` page is caused by a malformed invite URL, not by the bot
token. Use the URL printed in the server logs after `Discord bot logged in`,
or open `/api/discord/invite` on the running service and copy its `inviteUrl`.
That URL includes the required `bot` and `applications.commands` scopes and a
valid permission bitfield.

If you create the URL manually in the Discord Developer Portal, use the OAuth2
URL Generator with these scopes:

The scopes are `bot` and `applications.commands`. The generated bot
permissions should include View Channel, Send Messages, Embed Links, Read
Message History, and Manage Server.

Separately, in the **Bot** page of the Developer Portal, enable Server Members
Intent. Message Content Intent is only needed for historical log import.

Give the bot access to the log channel with:

- View Channel
- Send Messages
- Embed Links
- Read Message History

Invite attribution also needs the bot to be able to fetch server invites. The bot account typically needs Manage Server / Manage Guild for that Discord API operation.

## Environment

- `DISCORD_TOKEN` — stored as a Replit Secret. `DISCORD_BOT_TOKEN` and
  `BOT_TOKEN` are also accepted for compatibility.
- `DISCORD_CLIENT_ID` — optional application ID used to build the invite URL
  before the bot has finished logging in; normally the ID is discovered from
  the authenticated bot automatically.
- `INVITE_LOG_CHANNEL_ID` — optional default log channel. If it is not present
  in a server, the bot automatically chooses and persists the first writable
  text channel for that server.
- `SERVER_LABEL` — label shown in the embed author/footer
- `HISTORICAL_LOG_CHANNEL_ID` — optional source channel for old logs
- `IMPORT_HISTORICAL_LOGS` — set to `true` for a one-time import, then turn it off

Discord cannot reconstruct every historical join after an invite has expired or been deleted. Active invite usage totals and accessible historical messages are the available sources.

You do not need to send or paste the token again. Keep the existing secret if
it is valid and named `DISCORD_TOKEN` (or one of the accepted aliases). Only
regenerate the token in Discord if it was exposed or Discord reports that it is
invalid; after regenerating, update the existing Replit Secret.