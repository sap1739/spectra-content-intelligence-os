# Meta live verification checklist

The Facebook and Instagram adapters are tested end to end against a local server that follows
Meta's documentation (`apps/api/test/meta.spec.ts`). They have **not** been run against Meta
itself. Run this list against a real Meta app, a test Page and a test Instagram professional
account before relying on them, and record the result.

Use a throwaway Page and Instagram account. Delete test posts afterwards.

**Environment**

- [ ] `META_GRAPH_API_VERSION` is a version Meta currently supports
      (<https://developers.facebook.com/docs/graph-api/changelog>).
- [ ] API and worker share `SOCIAL_TOKEN_ENCRYPTION_KEY` and the Facebook App ID and App Secret.
- [ ] `META_GRAPH_API_BASE_URL` is unset (real Meta).
- [ ] `STORAGE_ENDPOINT` is reachable from the internet; the worker does not log that Instagram
      publishing is unavailable.

**Connect and discover**

- [ ] Connect as a user with a role on the app. The callback returns `oauth=connected`.
- [ ] The token endpoint accepts the GET code exchange, which carries the standard
      `grant_type=authorization_code` beside Meta's documented parameters. **If Meta refuses it,
      record the error** — the parameter would then have to be dropped for Meta.
- [ ] The long-lived exchange succeeds: the connection's token expiry is about 60 days out.
- [ ] Granted permissions come from `/me/permissions` (`grantedScopesReported` is true); a
      permission declined in Meta's dialog shows as missing on the connection.
- [ ] Each Page you manage appears with its real name; a Page where your role lacks Create
      content shows "permission missing".
- [ ] A professional Instagram account linked to a Page appears as eligible; a personal account
      connected only through Page settings appears as "cannot publish here".
- [ ] With **Require App Secret** on, every call still succeeds (`appsecret_proof` accepted).
- [ ] Graph API Explorer's Access Token Debugger shows a stored Page token as **Expires: Never**.

**Publish to a Page**

- [ ] A text post returns `PUBLISHED`, and "View post" opens it.
- [ ] A PNG and a JPEG photo post with the caption.
- [ ] A WebP image is refused at scheduling time.
- [ ] A user without Create content on the Page gets `PERMISSION`, not a crash.

**Publish to Instagram**

- [ ] A 1080×1350 JPEG with a caption and alt text returns `PUBLISHED`; the permalink opens it;
      the alt text is set (Instagram → the post → Accessibility).
- [ ] Storage access logs show Meta fetching the signed link.
- [ ] A PNG and a 1080×1600 JPEG are refused at scheduling time.
- [ ] `content_publishing_limit` answers with the Page token (Meta's reference describes a user
      token — **record which works**).
- [ ] `alt_text` is accepted on the container (documented since 2025-03-24).

**Failure and retry**

- [ ] Remove the app under Facebook Settings → Business integrations (or change the password),
      then publish: the entry fails `AUTH`, the connection becomes "reconnect required", and the
      next publish stops before calling Meta.
- [ ] Reconnect restores publishing without creating a second connection or duplicate accounts.
- [ ] Re-publishing an Instagram entry whose post already went out does not post it twice.

**Hygiene**

- [ ] No user token, Page token, App Secret or `appsecret_proof` appears in API or worker logs.
- [ ] Disconnect deletes the stored tokens; the UI says to remove the app in Facebook's settings.

**Record**

| Date | Graph version | App review status | Result | Notes |
| ---- | ------------- | ----------------- | ------ | ----- |
|      |               |                   |        |       |
