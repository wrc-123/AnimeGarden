import type { Context } from 'hono';

import { sql } from 'kysely';
import { memoAsync } from 'memofunc';
import { hash, objectHash, sha256 } from 'ohash';
import {
  parseSearchURL,
  normalizeTitle,
  fetchDmhyDetail,
  ResolvedFilterOptions
} from 'animegarden';

import type { Env } from './types';

import { connect } from './database';
import { createTimer, isNoCache } from './util';
import { getDetailStore, getRefreshTimestamp, getResourcesStore } from './state';

export async function queryResourceDetail(ctx: Context<{ Bindings: Env }>) {
  const store = getDetailStore(ctx.env);

  const href = ctx.req.param('href');
  const id = resolveId(href);
  if (id === undefined) {
    return ctx.json({ message: '404 NOT FOUND' }, 404);
  }

  const cache = await store.get('' + id);
  if (!!cache) {
    return ctx.json({ id, detail: cache });
  }

  const db = connect(ctx.env);
  const realHref = /^\d+$/.test(href)
    ? (
        await db
          .selectFrom('Resource')
          .select('Resource.href')
          .where('Resource.id', '=', +href)
          .execute()
      )[0]?.href
    : href;

  const resp = await fetchDmhyDetail(fetch, realHref);
  if (!resp) {
    return ctx.json({ message: '404 NOT FOUND' }, 404);
  }

  // Ignore cache put error
  const detail = { ...resp, id };
  await store.put('' + id, detail, { expirationTtl: 60 * 60 * 24 * 7 }).catch(() => {});

  return ctx.json({ id, detail });

  function resolveId(href: string) {
    const id = href.split('_')[0];
    return id && /^\d+$/.test(id) ? +id : undefined;
  }
}

export const PrefetchFilter = [
  parseSearchURL(new URLSearchParams('?page=1&pageSize=80&type=動畫')),
  parseSearchURL(new URLSearchParams('?page=2&pageSize=80&type=動畫')),
  parseSearchURL(new URLSearchParams('?page=1&pageSize=80'))
];

export const findResourcesFromDB = memoAsync(
  async (env: Env, options: ResolvedFilterOptions) => {
    const timer = createTimer(`Search Resources`);
    timer.start();

    const db = connect(env);
    const timestampPromise = getRefreshTimestamp(env);

    const {
      page,
      pageSize,
      fansubId,
      fansubName,
      publisherId,
      type,
      before,
      after,
      search,
      include,
      exclude
    } = options;

    const query = db
      .selectFrom('Resource')
      .select([
        'Resource.id',
        'Resource.href',
        'Resource.title',
        'Resource.titleAlt',
        'Resource.type',
        'Resource.size',
        'Resource.magnet',
        'Resource.createdAt',
        'Resource.anitomy',
        'Resource.fansubId',
        'Resource.publisherId',
        'Resource.isDeleted'
      ])
      .leftJoin('User', 'Resource.publisherId', 'User.id')
      .leftJoin('Team', 'Resource.fansubId', 'Team.id')
      .select('User.name as publisherName')
      .select('Team.name as fansubName')
      .where(({ and, or, eb }) =>
        and(
          [
            eb('Resource.isDeleted', '=', 0),
            type ? eb('Resource.type', '=', type) : undefined,
            after ? eb('Resource.createdAt', '>=', after) : undefined,
            before ? eb('Resource.createdAt', '<=', before) : undefined,
            // fansub
            (fansubId && fansubId.length > 0) || (fansubName && fansubName.length > 0)
              ? or(
                  [
                    fansubId && fansubId.length > 0 ? eb('Team.id', 'in', fansubId) : undefined,
                    fansubName && fansubName.length > 0
                      ? eb('Team.name', 'in', fansubName)
                      : undefined
                  ].filter(Boolean)
                )
              : undefined,
            // publisher
            publisherId && publisherId.length > 0
              ? or(
                  [
                    publisherId && publisherId.length > 0
                      ? eb('User.id', 'in', publisherId)
                      : undefined
                  ].filter(Boolean)
                )
              : undefined,
            // Include
            ...(include?.map((include) =>
              or(include.map((t) => eb('Resource.titleAlt', 'like', `%${normalizeTitle(t)}%`)))
            ) ?? []),
            // Exclude
            ...(exclude?.map((t) =>
              eb('Resource.titleAlt', 'not like', `%${normalizeTitle(t)}%`)
            ) ?? [])
          ].filter(Boolean)
        )
      )
      // Search
      .$if(!!search && search.length > 0, (qb) =>
        qb.where(sql`MATCH(Resource.titleAlt) AGAINST (${search!.join(' ')} IN BOOLEAN MODE)`)
      )
      .orderBy('Resource.id desc')
      .offset((page - 1) * pageSize)
      .limit(pageSize + 1); // Used for determining whether there are rest resources

    const result = await query.execute();

    const timestamp = await timestampPromise;
    timer.end();

    return {
      filter: options,
      timestamp,
      resources: result
    };
  },
  {
    external: {
      async get([env, params]) {
        const store = getResourcesStore(env);
        const key = hash(params);

        const [resp, timestamp] = await Promise.all([
          store.get(key),
          getRefreshTimestamp(env)
        ] as const);

        if (resp) {
          if (resp.timestamp.getTime() === timestamp.getTime()) {
            return resp;
          }
          // Cache miss
          await store.remove(key);
        }

        return undefined;
      },
      async set([env, params], value) {
        const key = hash(params);
        return getResourcesStore(env).put(key, value, {
          expirationTtl: 60 * 10
        });
      },
      async remove([env, params]) {
        return getResourcesStore(env).remove(hash(params));
      },
      async clear() {}
    }
  }
);

export async function searchResources(ctx: Context<{ Bindings: Env }>) {
  const url = new URL(ctx.req.url);
  const filter = parseSearchURL(url.searchParams, await ctx.req.json().catch(() => undefined));
  if (!filter) {
    return ctx.json({ message: 'Request is not valid' }, 400);
  }

  const noCache = isNoCache(ctx);
  const { timestamp, resources: result } = !noCache
    ? await findResourcesFromDB(ctx.env, filter)
    : await findResourcesFromDB.raw(ctx.env, filter);

  const complete = result.length <= filter.pageSize;
  const resources = resolveQueryResult(result.slice(0, filter.pageSize));

  return ctx.json({
    filter,
    complete,
    timestamp,
    resources
  });
}

function resolveQueryResult(result: Awaited<ReturnType<typeof findResourcesFromDB>>['resources']) {
  return result.map((r) => ({
    id: r.id,
    title: r.title,
    href: `https://share.dmhy.org/topics/view/${r.href}`,
    type: r.type,
    magnet: r.magnet,
    size: r.size,
    // When reading this field from cache, it will be transfromed to string
    createdAt:
      typeof r.createdAt === 'string' && /^\d+$/.test(r.createdAt)
        ? new Date(Number(r.createdAt))
        : new Date(r.createdAt),
    fansub: r.fansubName
      ? {
          id: r.fansubId,
          name: r.fansubName,
          href: `https://share.dmhy.org/topics/list/team_id/${r.fansubId}`
        }
      : undefined,
    publisher: {
      id: r.publisherId,
      name: r.publisherName!,
      href: `https://share.dmhy.org/topics/list/user_id/${r.publisherId}`
    }
  }));
}
