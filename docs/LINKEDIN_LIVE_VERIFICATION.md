# LinkedIn live verification checklist

The adapter is tested end to end against a local server that follows LinkedIn's documentation
(`apps/api/test/linkedin.spec.ts`). It has **not** been run against LinkedIn itself. Run this list
against a real LinkedIn app and a test member/page before relying on it, and record the result.

Use a throwaway LinkedIn page and a test member. Delete test posts afterwards.

**Environment**

- [ ] `LINKEDIN_API_VERSION` is a version LinkedIn currently supports (check
      <https://learn.microsoft.com/en-us/linkedin/marketing/versioning>).
- [ ] API and worker share `SOCIAL_TOKEN_ENCRYPTION_KEY` and the LinkedIn client id/secret.
- [ ] `LINKEDIN_API_BASE_URL` is unset (real LinkedIn).

**Connect and discover**

- [ ] Connect with the self-serve scopes (`openid profile w_member_social`). The callback returns
      `oauth=connected`.
- [ ] The member appears with their real name and `urn:li:person:<sub>`; no email is stored.
- [ ] The connection lists Community Management as missing, marked as reviewed by LinkedIn.
- [ ] The token response's `scope` field is recorded as granted scopes (`grantedScopesReported`
      is true).
- [ ] With Community Management: pages where the member is ADMINISTRATOR appear with their names;
      a page where they are only ANALYST does not.
- [ ] Requesting a scope the app lacks makes LinkedIn refuse the sign-in, and Spectra shows
      `provider_error` (not a crash).

**Publish as the member (the largest open question)**

- [ ] A text post to the member profile returns `PUBLISHED`, and the "View post" link opens it.
      LinkedIn's Share on LinkedIn page documents the legacy `ugcPosts` API; Spectra uses the Posts
      API, which documents `w_member_social`. **If LinkedIn returns 403 here for a self-serve app,
      record it** — member posting then needs Community Management access or a `ugcPosts` path.
- [ ] Reserved characters render literally: `(parentheses) [brackets] a_b *stars* @name`.
- [ ] `#hashtag` renders as a clickable hashtag.
- [ ] A 3,001-character post is refused at scheduling time.
- [ ] A PNG with alt text posts with the image visible; the alt text is set.
- [ ] A GIF and a JPG post correctly. A WebP is refused at scheduling time.

**Publish as a page**

- [ ] A text post as the page returns `PUBLISHED`.
- [ ] An image post as the page waits for processing (`SocialMediaUpload.verified = true`).
- [ ] A member without a posting role on a page gets `PERMISSION`, not a crash.

**Failure and retry**

- [ ] Revoke the app under LinkedIn Settings → Data privacy → Permitted services, then publish:
      the entry fails `AUTH`, the connection becomes "reconnect required", and the next publish
      stops before calling LinkedIn.
- [ ] Reconnect restores publishing without creating a second connection.
- [ ] Re-publishing a failed image entry reuses the uploaded image (no second `initializeUpload`).
- [ ] If the app has refresh tokens: set `accessTokenExpiresAt` into the past and publish — the
      worker refreshes and posts.
- [ ] Without refresh tokens: an expired token fails `REAUTH_REQUIRED` with "Reconnect LinkedIn".

**Hygiene**

- [ ] No access token, refresh token or client secret appears in API or worker logs.
- [ ] Disconnect deletes the stored credential; the UI says to remove the app in LinkedIn's
      settings.

**Record**

| Date | Version | App products | Result | Notes |
| ---- | ------- | ------------ | ------ | ----- |
|      |         |              |        |       |
