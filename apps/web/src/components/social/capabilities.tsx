'use client';

import { Badge } from '@spectra/ui';

import {
  capabilitiesOf,
  type AccountCapabilities,
  type PostType,
  type PostTypeSupport,
} from '@/lib/social';

/**
 * Per-account publishing capabilities (Phase 6D, ADR-0035). A gap is labelled
 * for what it is — a missing permission is not the same as a feature the
 * adapter does not implement — and its reason is written out, never left in a
 * tooltip.
 */

const POST_TYPES: readonly PostType[] = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'];
const LABEL: Record<PostType, string> = {
  TEXT: 'Text',
  IMAGE: 'Image',
  VIDEO: 'Video',
  DOCUMENT: 'Document',
};
const STYLE: Record<
  PostTypeSupport,
  { suffix: string; variant: 'success' | 'warning' | 'muted' | 'outline' }
> = {
  AVAILABLE: { suffix: '', variant: 'success' },
  MISSING_PERMISSION: { suffix: ' — permission missing', variant: 'warning' },
  NOT_IMPLEMENTED: { suffix: ' — not implemented', variant: 'muted' },
  UNKNOWN: { suffix: ' — unconfirmed', variant: 'outline' },
};

export function PostTypeBadges({
  capabilities,
  showReasons = true,
}: {
  capabilities: AccountCapabilities;
  showReasons?: boolean;
}) {
  const gaps = POST_TYPES.filter((type) => capabilities.postTypes[type].status !== 'AVAILABLE');
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-wrap gap-1" aria-label="What this account can publish">
        {POST_TYPES.map((type) => {
          const style = STYLE[capabilities.postTypes[type].status];
          return (
            <li key={type}>
              <Badge variant={style.variant}>
                {LABEL[type]}
                {style.suffix}
              </Badge>
            </li>
          );
        })}
      </ul>
      {showReasons && gaps.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
          {gaps.map((type) => (
            <li key={type}>
              {LABEL[type]}: {capabilities.postTypes[type].reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Badges for an account's stored snapshot; nothing for a manual target without one. */
export function AccountCapabilityBadges({
  value,
  showReasons = true,
}: {
  value: unknown;
  showReasons?: boolean;
}) {
  const capabilities = capabilitiesOf(value);
  return capabilities ? (
    <PostTypeBadges capabilities={capabilities} showReasons={showReasons} />
  ) : null;
}

/** Operator setup for LinkedIn, next to its Connect button. */
export function LinkedInSetupGuide({ redirectUri }: { redirectUri: string | null }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium">LinkedIn setup</summary>
      <ol className="mt-1 list-decimal space-y-1 pl-4 text-muted-foreground">
        <li>Create an app at linkedin.com/developers and verify it with your LinkedIn page.</li>
        <li>
          On its Products tab, add <strong>Sign In with LinkedIn using OpenID Connect</strong> and{' '}
          <strong>Share on LinkedIn</strong> (both self-serve). To post as a page, request the{' '}
          <strong>Community Management API</strong> — LinkedIn reviews it.
        </li>
        <li>
          Under Auth, add the authorized redirect URL
          {redirectUri ? (
            <>
              : <code className="break-all">{redirectUri}</code>
            </>
          ) : (
            ' shown above'
          )}
          .
        </li>
        <li>
          Set SOCIAL_OAUTH_LINKEDIN_CLIENT_ID and SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET. Set
          SOCIAL_OAUTH_LINKEDIN_SCOPES only to scopes your app has — LinkedIn refuses the sign-in if
          it asks for one the app lacks.
        </li>
      </ol>
    </details>
  );
}
