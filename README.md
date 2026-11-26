# ProBuddy

ProBuddy is the Next.js web companion for authenticated Protocol sharing
sessions. It joins the Render WebSocket at `wss://provibe.onrender.com` by
default; override it with `NEXT_PUBLIC_WS_URL` if needed.

## Local setup

Copy `.env.example` to `.env.local` and add the Supabase anon keys:

```powershell
npm ci
npm run dev
```

## Vercel deployment

Set these variables in the Vercel project settings before building:

- `NEXT_PUBLIC_WS_URL` — `wss://provibe.onrender.com`
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL(s), comma-separated only if
  configuring multiple independent projects
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — matching public anon key(s), in the same
  order as the URLs

The `NEXT_PUBLIC_` values are part of the browser bundle, so never put a
service-role key in them. The Render backend separately needs `SUPABASE_URLS`,
`SUPABASE_KEYS`, and `ALLOWED_ORIGINS`.

Multiple Supabase URLs are independent projects, not a replicated cluster.
The desktop host and browser viewer must sign in to the same Supabase account
on the same project.
Chat history and private screen-frame history are stored in that project;
current frames are also relayed live over the authenticated WebSocket.
