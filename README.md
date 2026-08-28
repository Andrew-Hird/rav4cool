# rav4cool

## Upload API

The Worker accepts Shortcut uploads at `https://api.rav4.cool/upload`.
Configure the revocable token with:

```bash
wrangler secret put UPLOAD_API_TOKEN --config worker/wrangler.jsonc
```

Send a `POST` multipart request with an `Authorization: Bearer ...` header,
the image in a `photo` field, and an optional `date` field in `YYYYMMDD`
format. The endpoint returns `202` after storing the private upload; image
processing and gallery publication happen asynchronously through the queue.
The existing 20 MiB limit and supported image extensions still apply.

Email upload uses Cloudflare Email Routing to forward a private address to
this Worker. Configure the exact authorized envelope senders as a comma-
separated secret:

```bash
wrangler secret put AUTHORIZED_UPLOAD_EMAILS --config worker/wrangler.jsonc
```

The first supported non-empty image attachment is processed. An optional
subject token such as `date: 20260829` supplies the date; otherwise the date
comes from the filename or the current Auckland date. Additional attachments
are ignored. Sender allowlisting is an authorization check, not cryptographic
proof against SMTP spoofing.

Captions and Cloudflare AI enrichment are intentionally deferred. AI should
not be used as the authoritative source for a sighting date.