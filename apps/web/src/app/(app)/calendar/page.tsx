'use client';

import { SOCIAL_PLATFORMS } from '@spectra/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
  cn,
} from '@spectra/ui';
import { Calendar, ExternalLink, Send, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { PageHeader } from '@/components/page-header';
import { PostTypeBadges } from '@/components/social/capabilities';
import { useWorkspace } from '@/lib/auth';
import {
  useCalendar,
  useCancelEntry,
  usePublishNow,
  useScheduleEntry,
  type CalendarEntryRow,
} from '@/lib/calendar';
import { useContentItems } from '@/lib/content';
import { useMediaAssets } from '@/lib/media';
import { cannotPublishReason, capabilitiesOf, useSocialAccounts } from '@/lib/social';

const fieldClass = cn(
  'w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm shadow-sm',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

const STATUS_VARIANT: Record<
  string,
  'success' | 'muted' | 'secondary' | 'destructive' | 'warning'
> = {
  SCHEDULED: 'secondary',
  QUEUED: 'warning',
  PUBLISHING: 'warning',
  PUBLISHED: 'success',
  FAILED: 'destructive',
  UNSUPPORTED: 'muted',
  CANCELLED: 'muted',
};

const PUBLISHABLE = new Set(['SCHEDULED', 'UNSUPPORTED', 'FAILED']);

function groupByDay(entries: CalendarEntryRow[]): Array<[string, CalendarEntryRow[]]> {
  const map = new Map<string, CalendarEntryRow[]>();
  for (const e of entries) {
    const day = new Date(e.scheduledAt).toLocaleDateString();
    (map.get(day) ?? map.set(day, []).get(day)!).push(e);
  }
  return [...map.entries()];
}

const FORMAT: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/gif': 'GIF',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
};

/** "JPG", "JPG, PNG or GIF" — from what the target actually accepts. */
function formatList(mimeTypes: string[]): string {
  const names = mimeTypes.map((m) => FORMAT[m] ?? m.replace('image/', '').toUpperCase());
  if (names.length <= 1) return names[0] ?? 'image';
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

export default function CalendarPage() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace.id;

  const calendar = useCalendar(workspaceId);
  const items = useContentItems(workspaceId);
  const accounts = useSocialAccounts(workspaceId);
  const media = useMediaAssets(workspaceId);
  const schedule = useScheduleEntry(workspaceId);
  const cancel = useCancelEntry(workspaceId);
  const publish = usePublishNow(workspaceId);

  const approved = (items.data ?? []).filter((i) =>
    ['APPROVED', 'SCHEDULED'].includes(i.lifecycleState),
  );

  const [contentItemId, setContentItemId] = React.useState('');
  const [platform, setPlatform] = React.useState<string>('LINKEDIN');
  const [accountId, setAccountId] = React.useState('');
  const [mediaAssetId, setMediaAssetId] = React.useState('');
  const [altText, setAltText] = React.useState('');
  const [when, setWhen] = React.useState('');
  // YouTube publishes a video with its own details (Phase 6F).
  const [thumbnailAssetId, setThumbnailAssetId] = React.useState('');
  const [ytTitle, setYtTitle] = React.useState('');
  const [ytDescription, setYtDescription] = React.useState('');
  const [ytTags, setYtTags] = React.useState('');
  const [ytCategory, setYtCategory] = React.useState('');
  const [ytPrivacy, setYtPrivacy] = React.useState('private');
  const [ytMadeForKids, setYtMadeForKids] = React.useState(false);
  const [ytNotify, setYtNotify] = React.useState(true);
  // TikTok publishes a video with its own caption and privacy (Phase 6G).
  const [ttCaption, setTtCaption] = React.useState('');
  const [ttPrivacy, setTtPrivacy] = React.useState('SELF_ONLY');
  const [ttDisableComment, setTtDisableComment] = React.useState(false);
  const [ttDisableDuet, setTtDisableDuet] = React.useState(false);
  const [ttDisableStitch, setTtDisableStitch] = React.useState(false);
  // A pin can send people somewhere.
  const [pinLink, setPinLink] = React.useState('');

  // Only accounts on the chosen platform can be targets.
  const targets = (accounts.data ?? []).filter((a) => a.platform === platform);
  const selected = targets.find((a) => a.id === accountId) ?? null;
  const caps = selected ? capabilitiesOf(selected.capabilities) : null;
  // An image is offered only where the target can genuinely publish one.
  const canAttachImage = caps?.postTypes.IMAGE.status === 'AVAILABLE';
  // Instagram has no text-only posts: there, the image is the post.
  const imageRequired = canAttachImage && caps?.postTypes.TEXT.status === 'NOT_SUPPORTED';
  const images = (media.data ?? []).filter(
    (m) => m.kind === 'IMAGE' && (caps?.limits.imageMimeTypes ?? []).includes(m.mimeType),
  );
  // YouTube: the post IS a video, with details and an optional thumbnail.
  const isYouTube = platform === 'YOUTUBE';
  const canPublishVideo = caps?.postTypes.VIDEO.status === 'AVAILABLE';
  const videos = (media.data ?? []).filter((m) => m.kind === 'VIDEO');
  const thumbnails = (media.data ?? []).filter(
    (m) => m.kind === 'IMAGE' && ['image/jpeg', 'image/png'].includes(m.mimeType),
  );
  // What the platform itself warned about this account (audit status, quota).
  const accountNotes = ((selected?.capabilities as { notes?: unknown } | null)?.notes ??
    []) as string[];
  const isTikTok = platform === 'TIKTOK';
  const isPinterest = platform === 'PINTEREST';
  const selectedItemTitle = approved.find((i) => i.id === contentItemId)?.title ?? '';
  // A video needs a title of its own; the content item's is the obvious start.
  React.useEffect(() => {
    if (selectedItemTitle) setYtTitle((current) => current || selectedItemTitle.slice(0, 100));
  }, [selectedItemTitle]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!contentItemId || !when) return;
    const publishMetadata = {
      ...(isTikTok && canPublishVideo && mediaAssetId
        ? {
            tiktok: {
              title: ttCaption.trim() || selectedItemTitle,
              privacyLevel: ttPrivacy as 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY',
              disableComment: ttDisableComment,
              disableDuet: ttDisableDuet,
              disableStitch: ttDisableStitch,
              // Declarations the creator is responsible for; Spectra never sets them.
              brandContentToggle: false,
              brandOrganicToggle: false,
              isAigc: false,
            },
          }
        : {}),
      ...(isPinterest && canAttachImage && mediaAssetId && pinLink.trim()
        ? { pinterest: { link: pinLink.trim() } }
        : {}),
      ...(isYouTube && canPublishVideo && mediaAssetId
        ? {
            youtube: {
              title: ytTitle.trim(),
              ...(ytDescription.trim() ? { description: ytDescription } : {}),
              tags: ytTags
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
              ...(ytCategory.trim() ? { categoryId: ytCategory.trim() } : {}),
              privacyStatus: ytPrivacy as 'private' | 'unlisted' | 'public',
              madeForKids: ytMadeForKids,
              notifySubscribers: ytNotify,
            },
          }
        : {}),
    };

    await schedule.mutateAsync({
      contentItemId,
      platform: platform as never,
      scheduledAt: new Date(when).toISOString(),
      ...(accountId ? { socialAccountId: accountId } : {}),
      ...(canAttachImage && mediaAssetId
        ? { mediaAssetId, ...(altText.trim() ? { mediaAltText: altText.trim() } : {}) }
        : {}),
      ...((isTikTok || isYouTube) && canPublishVideo && mediaAssetId ? { mediaAssetId } : {}),
      ...(isYouTube && canPublishVideo && mediaAssetId && thumbnailAssetId
        ? { thumbnailAssetId }
        : {}),
      ...(Object.keys(publishMetadata).length > 0 ? { publishMetadata } : {}),
    });
    setWhen('');
    setMediaAssetId('');
    setAltText('');
    setThumbnailAssetId('');
  };

  const days = groupByDay(calendar.data ?? []);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Schedule approved content across channels (UTC storage, local display). Attach a target account to publish; the dispatcher runs due entries. WordPress, and LinkedIn, Facebook Page, Instagram professional and YouTube channel accounts found through a connection, publish for real; every other platform resolves to an honest UNSUPPORTED — never a fake success."
      />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Schedule content</CardTitle>
          </CardHeader>
          <CardContent>
            {approved.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approved content yet. Approve a content item in the Studio to schedule it.
              </p>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-item">Content item</Label>
                  <select
                    id="cal-item"
                    className={fieldClass}
                    value={contentItemId}
                    onChange={(e) => setContentItemId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {approved.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-platform">Platform</Label>
                  <select
                    id="cal-platform"
                    className={fieldClass}
                    value={platform}
                    onChange={(e) => {
                      setPlatform(e.target.value);
                      setAccountId('');
                      setMediaAssetId('');
                      setThumbnailAssetId('');
                      setPinLink('');
                    }}
                  >
                    {SOCIAL_PLATFORMS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-account">Publish to (optional)</Label>
                  <select
                    id="cal-account"
                    className={fieldClass}
                    value={accountId}
                    onChange={(e) => {
                      setAccountId(e.target.value);
                      setMediaAssetId('');
                    }}
                  >
                    <option value="">No target (plan only)</option>
                    {targets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                        {a.kind === 'PAGE' ? ' (page)' : ''}
                        {a.kind === 'BUSINESS_ACCOUNT' ? ' (professional)' : ''}
                        {cannotPublishReason(a.capabilities) ? ' — cannot publish' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                {selected && caps ? (
                  <div className="flex flex-col gap-1" aria-live="polite">
                    <p className="text-xs text-muted-foreground">This target can publish:</p>
                    <PostTypeBadges capabilities={caps} />
                  </div>
                ) : selected ? (
                  <p className="text-xs text-muted-foreground">
                    Registered by hand — what it can publish is checked when the entry runs.
                  </p>
                ) : null}
                {accountNotes.length > 0 ? (
                  <ul className="flex flex-col gap-1 rounded-md bg-muted/60 p-2" role="note">
                    {accountNotes.map((note) => (
                      <li key={note} className="text-[11px] text-muted-foreground">
                        {note}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {isTikTok && selected && canPublishVideo ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-tt-video">Video (required)</Label>
                      <select
                        id="cal-tt-video"
                        className={fieldClass}
                        value={mediaAssetId}
                        onChange={(e) => setMediaAssetId(e.target.value)}
                      >
                        <option value="">Select a video…</option>
                        {videos.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.mimeType.replace('video/', '').toUpperCase()} ·{' '}
                            {(m.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        {videos.length === 0
                          ? 'No videos yet — upload one on the Media page.'
                          : 'Uploaded in chunks; an interrupted publish is checked, never sent twice.'}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-tt-caption">Caption</Label>
                      <textarea
                        id="cal-tt-caption"
                        className={cn(fieldClass, 'min-h-16')}
                        value={ttCaption}
                        maxLength={2200}
                        onChange={(e) => setTtCaption(e.target.value)}
                        placeholder="Leave blank to use the content item"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-tt-privacy">Privacy</Label>
                      <select
                        id="cal-tt-privacy"
                        className={fieldClass}
                        value={ttPrivacy}
                        onChange={(e) => setTtPrivacy(e.target.value)}
                      >
                        <option value="SELF_ONLY">Private (only me)</option>
                        <option value="FOLLOWER_OF_CREATOR">Followers</option>
                        <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
                        <option value="PUBLIC_TO_EVERYONE">Everyone</option>
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        TikTok decides what this creator may use, and refuses anything else when the
                        post runs.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      {(
                        [
                          ['Comments off', ttDisableComment, setTtDisableComment],
                          ['Duets off', ttDisableDuet, setTtDisableDuet],
                          ['Stitches off', ttDisableStitch, setTtDisableStitch],
                        ] as Array<[string, boolean, (value: boolean) => void]>
                      ).map(([label, value, set]) => (
                        <label
                          key={label}
                          className="flex items-center gap-2 text-xs text-muted-foreground"
                        >
                          <input
                            type="checkbox"
                            checked={value}
                            onChange={(e) => set(e.target.checked)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </>
                ) : null}
                {isPinterest && selected && canAttachImage ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cal-pin-link">Destination link (optional)</Label>
                    <Input
                      id="cal-pin-link"
                      value={pinLink}
                      onChange={(e) => setPinLink(e.target.value)}
                      placeholder="https://example.com/page"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Where the pin sends people. Pinterest fetches the image itself from a
                      short-lived link.
                    </p>
                  </div>
                ) : null}
                {isYouTube && selected && canPublishVideo ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-video">Video (required)</Label>
                      <select
                        id="cal-video"
                        className={fieldClass}
                        value={mediaAssetId}
                        onChange={(e) => setMediaAssetId(e.target.value)}
                      >
                        <option value="">Select a video…</option>
                        {videos.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.mimeType.replace('video/', '').toUpperCase()} ·{' '}
                            {(m.sizeBytes / (1024 * 1024)).toFixed(1)} MB ·{' '}
                            {new Date(m.createdAt).toLocaleDateString()}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        {videos.length === 0
                          ? 'No videos yet — upload one on the Media page.'
                          : 'Uploaded resumably; an interrupted upload continues where it stopped.'}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-yt-title">Video title</Label>
                      <Input
                        id="cal-yt-title"
                        value={ytTitle}
                        maxLength={100}
                        onChange={(e) => setYtTitle(e.target.value)}
                        placeholder="What viewers see on YouTube"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-yt-description">Description</Label>
                      <textarea
                        id="cal-yt-description"
                        className={cn(fieldClass, 'min-h-20')}
                        value={ytDescription}
                        onChange={(e) => setYtDescription(e.target.value)}
                        placeholder="Leave blank to use the content item body"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="cal-yt-tags">Tags</Label>
                        <Input
                          id="cal-yt-tags"
                          value={ytTags}
                          onChange={(e) => setYtTags(e.target.value)}
                          placeholder="coffee, roasting"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="cal-yt-category">Category id</Label>
                        <Input
                          id="cal-yt-category"
                          value={ytCategory}
                          inputMode="numeric"
                          onChange={(e) => setYtCategory(e.target.value)}
                          placeholder="e.g. 22"
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-yt-privacy">Privacy</Label>
                      <select
                        id="cal-yt-privacy"
                        className={fieldClass}
                        value={ytPrivacy}
                        onChange={(e) => setYtPrivacy(e.target.value)}
                      >
                        <option value="private">Private</option>
                        <option value="unlisted">Unlisted</option>
                        <option value="public">Public</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="cal-yt-thumb">Thumbnail (optional)</Label>
                      <select
                        id="cal-yt-thumb"
                        className={fieldClass}
                        value={thumbnailAssetId}
                        onChange={(e) => setThumbnailAssetId(e.target.value)}
                      >
                        <option value="">No custom thumbnail</option>
                        {thumbnails.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.mimeType.replace('image/', '').toUpperCase()} ·{' '}
                            {(m.sizeBytes / 1024).toFixed(0)} KB
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        JPEG or PNG, up to 2 MB. YouTube may refuse it on an unverified channel; the
                        video still publishes.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={ytMadeForKids}
                        onChange={(e) => setYtMadeForKids(e.target.checked)}
                      />
                      Made for kids
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={ytNotify}
                        onChange={(e) => setYtNotify(e.target.checked)}
                      />
                      Notify subscribers
                    </label>
                  </>
                ) : null}
                {canAttachImage ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cal-image">
                      Image {imageRequired ? '(required)' : '(optional)'}
                    </Label>
                    <select
                      id="cal-image"
                      className={fieldClass}
                      value={mediaAssetId}
                      onChange={(e) => setMediaAssetId(e.target.value)}
                    >
                      <option value="">
                        {imageRequired ? 'Select an image…' : 'No image — text only'}
                      </option>
                      {images.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.mimeType.replace('image/', '').toUpperCase()} ·{' '}
                          {m.widthPx && m.heightPx ? `${m.widthPx}×${m.heightPx}` : 'size unknown'}{' '}
                          · {new Date(m.createdAt).toLocaleDateString()}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      One {formatList(caps?.limits.imageMimeTypes ?? [])} per post
                      {platform === 'INSTAGRAM' ? ', 4:5 to 1.91:1, up to 8 MB' : ''}
                      {images.length === 0 ? ' — none in Media yet' : ''}.
                    </p>
                  </div>
                ) : null}
                {canAttachImage && mediaAssetId ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cal-alt">Alt text</Label>
                    <Input
                      id="cal-alt"
                      value={altText}
                      maxLength={1000}
                      onChange={(e) => setAltText(e.target.value)}
                      placeholder="Describe the image for screen readers"
                    />
                  </div>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cal-when">When (local time)</Label>
                  <Input
                    id="cal-when"
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                </div>
                {schedule.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {schedule.error.message}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    schedule.isPending ||
                    !contentItemId ||
                    !when ||
                    (imageRequired && !mediaAssetId) ||
                    (isYouTube && canPublishVideo && (!mediaAssetId || !ytTitle.trim())) ||
                    (isTikTok && canPublishVideo && !mediaAssetId)
                  }
                >
                  {schedule.isPending ? 'Scheduling…' : 'Schedule'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <div>
          {calendar.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : calendar.isError ? (
            <EmptyState
              icon={<Calendar />}
              title="Could not load the calendar"
              description={calendar.error.message}
            />
          ) : days.length === 0 ? (
            <EmptyState
              icon={<Calendar />}
              title="Nothing scheduled yet"
              description="Schedule an approved content item to see it here."
            />
          ) : (
            <div className="flex flex-col gap-5">
              {days.map(([day, entries]) => (
                <div key={day}>
                  <p className="mb-2 text-sm font-semibold">{day}</p>
                  <ul className="flex flex-col gap-2">
                    {entries.map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{e.contentItem.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(e.scheduledAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}{' '}
                            · {e.platform}
                            {e.socialAccountId ? ' · targeted' : ''}
                            {e.mediaAsset
                              ? e.mediaAsset.kind === 'VIDEO'
                                ? ' · video'
                                : ' · image'
                              : ''}
                          </p>
                          {e.upload && e.upload.totalBytes && e.upload.status !== 'UPLOADED' ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              Upload{' '}
                              {Math.min(
                                100,
                                Math.round((e.upload.uploadedBytes / e.upload.totalBytes) * 100),
                              )}
                              % sent — an interrupted upload resumes from here.
                            </p>
                          ) : null}
                          {e.publishNote ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {e.publishNote}
                            </p>
                          ) : null}
                          {e.failureReason ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {e.failureReason}
                            </p>
                          ) : null}
                          {e.status === 'PUBLISHED' && e.externalUrl ? (
                            <a
                              href={e.externalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                            >
                              View post
                              <ExternalLink aria-hidden="true" className="size-3" />
                            </a>
                          ) : null}
                          {e.status === 'FAILED' &&
                          (e.failureCode === 'AUTH' ||
                            e.failureCode === 'REAUTH_REQUIRED' ||
                            e.failureCode === 'PERMISSION') ? (
                            <Link
                              href="/social-accounts"
                              className="mt-0.5 block text-[11px] text-primary underline-offset-2 hover:underline"
                            >
                              {e.failureCode === 'PERMISSION'
                                ? 'Check the connection’s permissions on Social Accounts'
                                : 'Reconnect on Social Accounts'}
                            </Link>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge variant={STATUS_VARIANT[e.status] ?? 'secondary'}>
                            {e.status}
                          </Badge>
                          {e.socialAccountId && PUBLISHABLE.has(e.status) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={publish.isPending}
                              onClick={() => publish.mutate(e.id)}
                            >
                              <Send aria-hidden="true" />
                              Publish now
                            </Button>
                          ) : null}
                          {e.status === 'SCHEDULED' ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Cancel ${e.contentItem.title} on ${e.platform}`}
                              disabled={cancel.isPending}
                              onClick={() => cancel.mutate(e.id)}
                            >
                              <X aria-hidden="true" />
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
