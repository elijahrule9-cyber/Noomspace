# Discord Invite Tracker

Discord bot service that tracks invite activity and posts compact screenshot-style join embeds.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required bot secret: `DISCORD_TOKEN` (the runtime also accepts
  `DISCORD_BOT_TOKEN` or `BOT_TOKEN`)
- Optional bot config: `INVITE_LOG_CHANNEL_ID`; each server gets an automatic
  writable text-channel fallback when this channel is not present there

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/discord-bot.ts` — Discord event handlers, slash commands, embed builders, and SQLite persistence
- `artifacts/api-server/README.md` — Discord Developer Portal intents and permission setup
- `data/invites.sqlite` — runtime invite scores and idempotency state (ignored by git)

## Architecture decisions

- The existing API service runner hosts the Discord client so there is one managed process and one health endpoint.
- SQLite is used for invite scores and counted joins because scores must survive restarts and joins must be idempotent.
- Join embeds intentionally omit extra score fields to match the supplied compact screenshot; scores remain available through `/invites`.

## Product

The bot logs newly created invites and member joins, attributes joins to invite creators when Discord exposes the invite-use delta, persists scores, and exposes `/invites` and `/invitechannel`.

## User preferences

- Match the supplied Discord embed screenshot, including the joining member’s PFP on the right side.

## Gotchas

- Enable Server Members Intent in the Discord Developer Portal. Message Content Intent is only needed for historical log import.
- Use the generated invite URL from the bot logs or `GET /api/discord/invite`;
  malformed OAuth2 URLs produce Discord's `Invalid Form Body` page.
- Discord cannot reconstruct every old join after an invite is deleted or expires; startup seeding uses active invite use counts.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
