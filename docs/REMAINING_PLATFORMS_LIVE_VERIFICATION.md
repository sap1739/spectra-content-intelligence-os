# TikTok, X, Threads and Pinterest live verification checklist

Each of these four adapters is tested end to end against a local server that follows the
platform's documentation (`apps/api/test/remaining-platforms.spec.ts` and the per-package unit
tests). **None has been run against the real platform** — there are no app credentials in this
environment. Run the relevant section against a real app and a throwaway account before relying on
it, and record the result.

Delete test posts afterwards. On TikTok and X each attempt costs a quota slot or credits.

**Common to all four**

- [ ] API and worker share `SOCIAL_TOKEN_ENCRYPTION_KEY` and the platform's client id/secret.
- [ ] The platform's redirect URI matches what Spectra shows on its card exactly.
- [ ] `*_API_BASE_URL` overrides are unset (real platforms).
- [ ] Connecting stores granted scopes, and the connection card lists any missing product.
- [ ] No access token, refresh token, client secret or signed upload URL appears in API or worker
      logs.
- [ ] Disconnect deletes the stored credential.

---

## TikTok

- [ ] Connect with `user.info.basic` + `video.publish`. The creator appears with their nickname.
- [ ] Discovery calls `creator_info/query` once and records the privacy levels TikTok returned.
- [ ] **Unaudited client:** ask for `PUBLIC_TO_EVERYONE`. TikTok's creator info should offer only
      `SELF_ONLY`, and Spectra refuses with the audit quote. **Record what TikTok actually
      returned.**
- [ ] Publish a ~10 MB MP4 privately: the entry reaches PUBLISHED, and the video appears in the
      creator's account.
- [ ] `social_media_uploads` holds the `publish_id`, its `uploadedBytes` reach the file size, and
      the sealed upload URL is cleared when the publish finishes.
- [ ] Publish the same entry again: Spectra checks the recorded publish rather than uploading a
      second video (no second `video/init/` call).
- [ ] A video over 10 minutes, and one in an unsupported format, are refused — by Spectra before
      upload where it can tell, otherwise by TikTok with its own `fail_reason`.
- [ ] An interaction the creator disabled (comments, duet, stitch) stays disabled on the post.
- [ ] Confirm the status endpoint's cadence is workable: TikTok allows 30 status calls per minute,
      and Spectra polls a few times before asking you to retry. **Record how long a real publish
      took to reach `PUBLISH_COMPLETE`.**

## X

- [ ] Connect with `tweet.read tweet.write users.read media.write offline.access`; the account
      appears as its handle and a refresh token is stored.
- [ ] A text post returns PUBLISHED and "View post" opens it.
- [ ] A post with two images: both upload through initialize/append/finalize, X reports
      `succeeded`, and the post carries both.
- [ ] **Record whether a post longer than 280 characters is accepted** for this account. Spectra
      caps at 280 because X's reference states no limit; if a verified account may post more, the
      cap needs revisiting.
- [ ] An identical post twice is refused by X (duplicate) and reported as a content problem.
- [ ] Exceed the rate limit (100/15 min per user) and confirm the entry records `RATE_LIMIT`.
- [ ] With an app that has no covering plan or no credits, publishing reports the access/plan
      refusal — not a generic failure. **Record X's exact status and body.**
- [ ] Let the two-hour token lapse, then publish: the worker refreshes and posts.

## Threads

- [ ] Connect with `threads_basic` + `threads_content_publish`; the profile appears as its handle.
- [ ] **Before advanced access:** posting works for your own account and app testers, and is
      refused for anyone else. **Record the refusal.**
- [ ] A text post returns PUBLISHED and the link opens it.
- [ ] An image post: the container is created, Spectra waits ~30 seconds, and the publish succeeds.
      Storage access logs show Meta fetching the signed link.
- [ ] A 9 MB image, a 200-pixel-wide image and a 12:1 image are refused at scheduling time.
- [ ] Interrupt after the container is created (stop the worker), then publish again: the same
      container is published — no second container, no double post.
- [ ] **Record the token lifetime** Meta issues here, and whether a refresh endpoint applies; the
      adapter currently asks for a reconnect instead.

## Pinterest

- [ ] Connect with `user_accounts:read boards:read pins:read pins:write`; every board is listed,
      following the `bookmark` pages, and the account itself is listed as not pinnable.
- [ ] A pin with a title, description, alt text and destination link is created on the chosen
      board and opens at `pinterest.com/pin/<id>/`.
- [ ] Storage access logs show Pinterest fetching the signed link.
- [ ] **Record what Pinterest refuses:** try a very small image, a very large one, and a WebP.
      Pinterest documents no formats or sizes, so whatever it answers should be written down here —
      and if it is stable, Spectra can start refusing those before the call.
- [ ] A board id that no longer exists returns Pinterest's 404 and is reported as a board problem.
- [ ] **Trial access:** confirm what it allows for an account other than the app owner's.

---

## Email

Nothing to verify: email is a documented placeholder, not an integration. See
`docs/REMAINING_PLATFORMS_SETUP.md` for what integrating one would require.

## Record

| Date | Platform | App/access status | Result | Notes |
| ---- | -------- | ----------------- | ------ | ----- |
|      |          |                   |        |       |
