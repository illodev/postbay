import type { FastifyReply, FastifyRequest } from 'fastify';
import { FakeServer, readAll, type Call } from './base.js';

/**
 * A stand-in for TikTok's Content Posting API: sign-in with rotating renewal tokens, the creator query, direct post of a
 * video by upload in pieces (or of photos pulled from a verified domain), and the status of a post. It enforces TikTok's own
 * rule that an app that has not been audited can only post privately, which is what the connector has to respect.
 * Written from the documentation, not from the real service.
 */
export class FakeTikTok extends FakeServer {
  clientKey = 'tkey';
  clientSecret = 'tsecret';
  user = { open_id: 'open-1', display_name: 'Lumen Coffee', username: 'lumencoffee' };
  accessTokens = new Set<string>(['tok']);
  refreshTokens = new Set<string>();
  tokenSeq = 0;
  revoked = false;
  /** Whether TikTok has audited the app: if not, only SELF_ONLY is accepted. */
  audited = false;
  privacyOptions = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'];
  maxDurationSec = 600;
  /** What the creator has switched off in TikTok, as creator_info reports it. */
  creator = { commentDisabled: false, duetDisabled: false, stitchDisabled: false };
  /** What every token is granted: what the app asks for. */
  grantedScopes = ['user.info.basic', 'video.publish', 'video.upload', 'video.list'];
  /** Photos are only downloaded from addresses that start with this. */
  verifiedDomain = 'https://media.test';
  posts = new Map<string, { id: string; kind: 'video' | 'photo'; info: any; source: any; received: { start: number; end: number }[]; size: number; polls: number; complete: boolean }>();
  statusPolls = 1;
  failWith: string | null = null;
  uploadUrlExpired = false;
  videos: Record<string, { id: string; view_count: number; like_count: number; comment_count: number; share_count: number }> = {};
  private n = 0;

  private token(grant: 'authorization_code' | 'refresh_token') {
    const access = `tok-${++this.tokenSeq}`;
    const refresh = `trefresh-${this.tokenSeq}`;
    this.accessTokens.add(access);
    this.refreshTokens.add(refresh);
    return { open_id: this.user.open_id, scope: this.grantedScopes.join(','), access_token: access, expires_in: 86400, refresh_token: refresh, refresh_expires_in: 31536000, token_type: 'Bearer', grant };
  }

  async handle(c: Call, req: FastifyRequest, reply: FastifyReply) {
    const body = (c.body ?? {}) as Record<string, any>;
    const ok = (data: unknown) => reply.send({ data, error: { code: 'ok', message: '', log_id: 'log' } });
    const bad = (status: number, code: string, message: string) => reply.code(status).send({ data: {}, error: { code, message, log_id: 'log' } });

    if (c.path === '/v2/oauth/token/') {
      if (body.client_key !== this.clientKey || body.client_secret !== this.clientSecret) return reply.code(401).send({ error: 'invalid_client', error_description: 'Client key or secret is wrong' });
      if (body.grant_type === 'authorization_code') {
        if (body.code === 'bad') return reply.code(400).send({ error: 'invalid_grant', error_description: 'Authorization code is expired or invalid' });
        return reply.send(this.token('authorization_code'));
      }
      if (body.grant_type === 'refresh_token') {
        if (this.revoked || !this.refreshTokens.has(body.refresh_token)) return reply.code(400).send({ error: 'invalid_grant', error_description: 'Refresh token is invalid or expired' });
        this.refreshTokens.delete(body.refresh_token);
        return reply.send(this.token('refresh_token'));
      }
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }

    // The upload address carries its own credential.
    let m = /^\/upload\/(.+)$/.exec(c.path);
    if (m && c.method === 'PUT') {
      const bytes = (await readAll(req)).length;
      const p = this.posts.get(m[1]!);
      if (!p || this.uploadUrlExpired) return reply.code(404).send('');
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(c.headers['content-range']));
      if (!range) return reply.code(400).send('');
      const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
      const expectedStart = p.received.length ? p.received.at(-1)!.end + 1 : 0;
      if (start !== expectedStart || end - start + 1 !== bytes || total !== p.size) return reply.code(416).send('');
      p.received.push({ start, end });
      if (end + 1 === total) {
        p.complete = true;
        return reply.code(201).send('');
      }
      return reply.code(206).send('');
    }

    const bearer = String(c.headers.authorization ?? '').replace(/^Bearer /, '');
    if (this.revoked || !this.accessTokens.has(bearer)) {
      await readAll(req);
      return bad(401, 'access_token_invalid', 'The access token is invalid or not found in the request.');
    }

    if (c.path === '/v2/user/info/') {
      // Each field belongs to a scope; asking for one the token was not granted refuses the whole call, as TikTok does.
      const scopeOf: Record<string, string> = {
        open_id: 'user.info.basic', union_id: 'user.info.basic', avatar_url: 'user.info.basic', avatar_url_100: 'user.info.basic', avatar_large_url: 'user.info.basic', display_name: 'user.info.basic',
        bio_description: 'user.info.profile', profile_deep_link: 'user.info.profile', is_verified: 'user.info.profile', username: 'user.info.profile',
        follower_count: 'user.info.stats', following_count: 'user.info.stats', likes_count: 'user.info.stats', video_count: 'user.info.stats',
      };
      const fields = String(c.query.fields ?? '').split(',').filter(Boolean);
      const missing = fields.find((f) => !this.grantedScopes.includes(scopeOf[f] ?? '\0'));
      if (missing) return bad(401, 'scope_not_authorized', 'The user did not authorize the scope required for completing this request.');
      const all: Record<string, unknown> = { ...this.user, union_id: `union-${this.user.open_id}`, avatar_url: 'https://p16.tiktokcdn.test/a.jpeg' };
      return ok({ user: Object.fromEntries(fields.map((f) => [f, all[f]])) });
    }
    if (c.path === '/v2/post/publish/creator_info/query/') {
      if (!this.grantedScopes.includes('video.publish')) return bad(401, 'scope_not_authorized', 'The user did not authorize the scope required for completing this request.');
      return ok({
        creator_avatar_url: 'https://p16.tiktokcdn.test/a.jpeg', creator_username: this.user.username, creator_nickname: this.user.display_name, privacy_level_options: this.privacyOptions,
        comment_disabled: this.creator.commentDisabled, duet_disabled: this.creator.duetDisabled, stitch_disabled: this.creator.stitchDisabled, max_video_post_duration_sec: this.maxDurationSec,
      });
    }

    const checkInfo = (info: any) => {
      if (!this.privacyOptions.includes(info?.privacy_level)) return bad(400, 'privacy_level_option_mismatch', 'The privacy level is not one of the options for this creator');
      if (!this.audited && info.privacy_level !== 'SELF_ONLY') return bad(403, 'unaudited_client_can_only_post_to_private_accounts', 'Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/');
      if (info.brand_content_toggle && info.privacy_level === 'SELF_ONLY') return bad(400, 'invalid_param', 'Branded content visibility cannot be set to private');
      return null;
    };

    if (c.path === '/v2/post/publish/video/init/') {
      const refused = checkInfo(body.post_info);
      if (refused) return refused;
      const s = body.source_info ?? {};
      if (s.source !== 'FILE_UPLOAD') return bad(400, 'invalid_param', 'source must be FILE_UPLOAD');
      const expectedCount = s.video_size <= s.chunk_size ? 1 : Math.floor(s.video_size / s.chunk_size);
      if (s.total_chunk_count !== expectedCount) return bad(400, 'invalid_param', `total_chunk_count should be ${expectedCount}`);
      const id = this.id('v_pub');
      this.posts.set(id, { id, kind: 'video', info: body.post_info, source: s, received: [], size: s.video_size, polls: 0, complete: false });
      return ok({ publish_id: id, upload_url: `${this.url}/upload/${id}` });
    }
    if (c.path === '/v2/post/publish/content/init/') {
      const refused = checkInfo(body.post_info);
      if (refused) return refused;
      const s = body.source_info ?? {};
      if (s.source !== 'PULL_FROM_URL' || !Array.isArray(s.photo_images) || s.photo_images.length < 1 || s.photo_images.length > 35) return bad(400, 'invalid_param', 'Photos need PULL_FROM_URL and 1 to 35 images');
      if (s.photo_images.some((u: string) => !u.startsWith(this.verifiedDomain))) return bad(403, 'url_ownership_unverified', 'Please verify the ownership of the URL prefix in the developer portal');
      if (String(body.post_info.title ?? '').length > 90) return bad(400, 'invalid_param', 'Title is too long');
      const id = this.id('p_pub');
      this.posts.set(id, { id, kind: 'photo', info: body.post_info, source: s, received: [], size: 0, polls: 0, complete: true });
      return ok({ publish_id: id });
    }
    if (c.path === '/v2/post/publish/status/fetch/') {
      const p = this.posts.get(body.publish_id);
      if (!p) return bad(400, 'invalid_publish_id', 'Unknown publish id');
      if (this.failWith) return ok({ status: 'FAILED', fail_reason: this.failWith });
      if (!p.complete) return ok({ status: 'PROCESSING_UPLOAD', uploaded_bytes: p.received.at(-1)?.end ?? 0 });
      p.polls++;
      if (p.polls <= this.statusPolls) return ok({ status: p.kind === 'photo' ? 'PROCESSING_DOWNLOAD' : 'PROCESSING_UPLOAD' });
      const isPrivate = p.info.privacy_level === 'SELF_ONLY';
      return ok({ status: 'PUBLISH_COMPLETE', ...(isPrivate ? {} : { publicaly_available_post_id: [`77${p.id.replace(/\D/g, '')}`] }) });
    }
    if (c.path === '/v2/video/query/') {
      const ids: string[] = body.filters?.video_ids ?? [];
      return ok({ videos: ids.map((i) => this.videos[i]).filter(Boolean) });
    }
    return bad(404, 'not_found', `no route ${c.method} ${c.path}`);
  }
}
