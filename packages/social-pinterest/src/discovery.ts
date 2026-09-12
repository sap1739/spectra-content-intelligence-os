import type {
  AccountDiscoveryPort,
  DiscoveredCapabilities,
  DiscoveredDestination,
  DiscoveredIdentity,
  DiscoveryContext,
} from '@spectra/social-core';
import { z } from 'zod';

import { pinterestBoardCapabilities } from './capabilities';
import { PinterestApiError, PinterestClient, type PinterestApiOptions } from './client';
import {
  PINTEREST_ACCESS_NOTE,
  PINTEREST_ADAPTER_VERSION,
  PINTEREST_ID,
  PINTEREST_PATHS,
  PINTEREST_PLATFORM,
  PINTEREST_SCOPES,
} from './constants';

/**
 * Pinterest account discovery through documented endpoints only:
 * `GET /v5/user_account` for who connected, and `GET /v5/boards` (paged with
 * `bookmark`) for the boards a pin can go to. A board Pinterest does not
 * return is not a destination.
 */

const accountSchema = z
  .object({ username: z.string().max(100).optional(), account_type: z.string().max(40).optional() })
  .passthrough();

const boardSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().max(300).optional(),
    privacy: z.string().max(40).optional(),
    pin_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const boardsSchema = z.object({
  items: z.array(z.unknown()).default([]),
  bookmark: z.string().max(2000).nullish(),
});

const MAX_PAGES = 5;
const PAGE_SIZE = 100;

export interface PinterestDiscoveryOptions extends PinterestApiOptions {
  /** Why Pinterest cannot fetch images from this deployment, or null. */
  mediaProblem?: string | null;
}

export class PinterestAccountDiscovery implements AccountDiscoveryPort {
  readonly platform = PINTEREST_PLATFORM;
  readonly adapterVersion = PINTEREST_ADAPTER_VERSION;

  constructor(
    private readonly options: PinterestDiscoveryOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private client(context: DiscoveryContext): PinterestClient {
    return new PinterestClient(context.accessToken, this.options);
  }

  async discoverCapabilities(context: DiscoveryContext): Promise<DiscoveredCapabilities> {
    return {
      grantedScopes: context.grantedScopes ? [...context.grantedScopes] : null,
      capabilityVersion: PINTEREST_ADAPTER_VERSION,
      notes: [
        `Pinning needs ${PINTEREST_SCOPES.pinsWrite}; listing boards needs ${PINTEREST_SCOPES.boardsRead}.`,
        PINTEREST_ACCESS_NOTE,
      ],
    };
  }

  async discoverIdentity(context: DiscoveryContext): Promise<DiscoveredIdentity> {
    const scopes = context.grantedScopes;
    let username = '';
    let accountType: string | undefined;
    if (scopes === null || scopes.includes(PINTEREST_SCOPES.profile)) {
      try {
        const body = await this.client(context).get<unknown>(PINTEREST_PATHS.userAccount);
        const parsed = accountSchema.safeParse(body ?? {});
        username = parsed.data?.username?.trim() ?? '';
        accountType = parsed.data?.account_type;
      } catch (error) {
        // Without the profile scope the account still exists; anything else is real.
        const soft = error instanceof PinterestApiError && error.kind === 'PERMISSION';
        if (!soft) throw error;
      }
    }
    const externalId = username || context.subjectId || '';
    if (!externalId || !PINTEREST_ID.test(externalId)) {
      throw new PinterestApiError(
        'UNKNOWN',
        null,
        null,
        'Pinterest did not return a usable account identifier',
      );
    }
    return {
      externalId,
      displayName: username ? `@${username}` : 'Pinterest account',
      kind: 'PROFILE',
      metadata: {
        nameReported: username.length > 0,
        ...(accountType ? { accountType } : {}),
      },
      // The account itself is not a place to pin — a board is.
      capabilities: {
        adapterVersion: PINTEREST_ADAPTER_VERSION,
        checkedAt: this.now().toISOString(),
        postTypes: {
          TEXT: notSupported(),
          IMAGE: notSupported(),
          VIDEO: notSupported(),
          DOCUMENT: notSupported(),
        },
        limits: { maxCharacters: null, maxImages: 0, imageMimeTypes: [] },
        notes: [PINTEREST_ACCESS_NOTE],
      },
    };
  }

  async discoverDestinations(context: DiscoveryContext): Promise<DiscoveredDestination[]> {
    const scopes = context.grantedScopes;
    // No board access granted: nothing is looked up and nothing is invented.
    if (scopes && !scopes.includes(PINTEREST_SCOPES.boardsRead)) return [];

    const client = this.client(context);
    const checkedAt = this.now();
    const boards: DiscoveredDestination[] = [];
    let bookmark: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let body: unknown;
      try {
        body = await client.get<unknown>(PINTEREST_PATHS.boards, {
          page_size: String(PAGE_SIZE),
          ...(bookmark ? { bookmark } : {}),
        });
      } catch (error) {
        if (scopes === null && error instanceof PinterestApiError && error.kind === 'PERMISSION') {
          return [];
        }
        throw error;
      }
      const parsed = boardsSchema.safeParse(body ?? {});
      if (!parsed.success) {
        throw new PinterestApiError(
          'UNKNOWN',
          null,
          null,
          'Pinterest returned an unexpected board list',
        );
      }
      for (const item of parsed.data.items) {
        const board = boardSchema.safeParse(item);
        if (!board.success || !PINTEREST_ID.test(board.data.id)) continue;
        const name = board.data.name?.trim() ?? '';
        boards.push({
          externalId: board.data.id,
          displayName: name || `Pinterest board ${board.data.id}`,
          kind: 'CHANNEL',
          metadata: {
            nameReported: name.length > 0,
            ...(board.data.privacy ? { privacy: board.data.privacy } : {}),
            ...(board.data.pin_count !== undefined ? { pinCount: board.data.pin_count } : {}),
          },
          capabilities: pinterestBoardCapabilities({
            grantedScopes: scopes,
            mediaProblem: this.options.mediaProblem ?? null,
            checkedAt,
          }),
        });
      }
      bookmark = parsed.data.bookmark ?? undefined;
      if (!bookmark) break;
    }
    return boards;
  }
}

function notSupported() {
  return {
    status: 'NOT_SUPPORTED' as const,
    reason: 'Pins go to a board, not to the account itself — pick a board as the target.',
    requiredScopes: [],
  };
}
