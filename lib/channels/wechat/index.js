/**
 * The WeChat adapter: Tencent iLink behind the {@link ChannelAdapter} seam.
 *
 * Adapter-owned state kept in the binding's state file:
 * - `ilinkUserId` — the person who scanned; the only sender accepted and the reply target;
 * - `botId` — the bot account iLink created for this login;
 * - `baseUrl` — the API host iLink assigned;
 * - `syncBuf` — the getupdates cursor;
 * - `contextToken` — the latest `context_token`, echoed on every reply.
 * The bot token itself lives in `ctx.credentials`.
 * @module im-robot/channels/wechat
 */
import { DEFAULT_BASE_URL, IlinkHttpError, STALE_TOKEN_ERRCODE, getConfig, isAbort } from "./api.js";
import { maskUserId, readInbound } from "./inbound.js";
import { DEFAULT_CDN_BASE_URL, saveMedia } from "./media.js";
import { DEFAULT_LOGIN_TIMING, loginWithQr } from "./login.js";
import { DEFAULT_MONITOR_TIMING, monitorUpdates } from "./monitor.js";
import { sendText } from "./send.js";
import { DEFAULT_TYPING_TIMING, TypingTickets, startTyping } from "./typing.js";
export { DEFAULT_BASE_URL } from "./api.js";
/** What a family member reads as `lastError` while the loop is not connected. */
export const CONNECTION_PROBLEM = {
    network: '连不上微信服务器，正在自动重连',
    server: '微信服务器暂时出错，正在自动重连',
    expired: '微信登录已失效，请重新绑定',
};
/** Default timeout of the `probe` call. */
const PROBE_TIMEOUT_MS = 5_000;
/** WeChat over iLink. */
export class WechatAdapter {
    channel = 'wechat';
    baseUrl;
    loginTiming;
    monitorTiming;
    typingTiming;
    probeTimeoutMs;
    cdnBaseUrl;
    mediaLimits;
    tickets = new Map();
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.loginTiming = { ...DEFAULT_LOGIN_TIMING, ...options.login };
        this.monitorTiming = { ...DEFAULT_MONITOR_TIMING, ...options.monitor };
        this.typingTiming = { ...DEFAULT_TYPING_TIMING, ...options.typing };
        this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
        this.cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
        this.mediaLimits = {
            ...(options.mediaTimeoutMs === undefined ? {} : { timeoutMs: options.mediaTimeoutMs }),
            ...(options.mediaMaxBytes === undefined ? {} : { maxBytes: options.mediaMaxBytes }),
        };
    }
    async *login(signal) {
        for await (const step of loginWithQr({ baseUrl: this.baseUrl, timing: this.loginTiming, signal })) {
            if (step.status !== 'confirmed') {
                yield step;
                continue;
            }
            const { token, botId, userId, baseUrl } = step.login;
            yield {
                status: 'confirmed',
                account: { token, user: maskUserId(userId), state: { ilinkUserId: userId, botId, baseUrl } },
            };
        }
    }
    async receive(link, deliver, signal) {
        const ownerId = link.state.ilinkUserId;
        if (!ownerId)
            throw new Error('the binding has no ilinkUserId; scan the login code again');
        await monitorUpdates({
            baseUrl: this.apiBase(link),
            cursor: link.state.syncBuf ?? '',
            token: () => link.token(),
            saveCursor: syncBuf => link.update({ syncBuf }),
            handle: async (message) => {
                const inbound = await readInbound(message, ownerId, item => saveMedia(item, {
                    directory: link.mediaDir,
                    cdnBaseUrl: this.cdnBaseUrl,
                    now: new Date(),
                    signal,
                    ...this.mediaLimits,
                }));
                if (inbound === undefined)
                    return;
                const contextToken = message.context_token?.trim();
                if (contextToken && contextToken !== link.state.contextToken)
                    await link.update({ contextToken });
                await deliver(inbound);
            },
            report: health => link.report(health === 'connected', health === 'connected' ? undefined : CONNECTION_PROBLEM[health]),
            logger: link.logger,
            label: `wechat binding ${link.bindingId}`,
            timing: this.monitorTiming,
            signal,
        });
    }
    replyContext(link) {
        return link.state.contextToken || undefined;
    }
    async send(link, text, context) {
        const token = await link.token();
        if (token === undefined)
            throw new Error('the binding has no stored credential');
        const to = link.state.ilinkUserId;
        if (!to)
            throw new Error('the binding has no ilinkUserId');
        await sendText({ baseUrl: this.apiBase(link), token, to, contextToken: context ?? link.state.contextToken }, text);
    }
    /** One getconfig call: it needs the bot token and only reads the account's typing ticket. */
    async probe(link, signal) {
        let token;
        try {
            token = await link.token();
        }
        catch {
            token = undefined;
        }
        try {
            const response = await getConfig(link.state.ilinkUserId ?? '', link.state.contextToken, {
                baseUrl: this.apiBase(link), token, timeoutMs: this.probeTimeoutMs, signal,
            });
            const code = response.ret !== undefined && response.ret !== 0 ? response.ret : response.errcode ?? 0;
            if (code === STALE_TOKEN_ERRCODE)
                return { reachable: true, tokenAccepted: false, problem: CONNECTION_PROBLEM.expired };
            if (code !== 0)
                return { reachable: true, problem: `微信服务器拒绝了这次检查（错误码 ${code}）` };
            return token === undefined ? { reachable: true } : { reachable: true, tokenAccepted: true };
        }
        catch (error) {
            if (error instanceof IlinkHttpError)
                return { reachable: false, problem: `微信服务器出错（HTTP ${error.status}）` };
            if (error instanceof SyntaxError)
                return { reachable: false, problem: '微信服务器的回答看不懂' };
            if (isAbort(error))
                return { reachable: false, problem: '微信服务器没有及时回应' };
            return { reachable: false, problem: '连不上微信服务器' };
        }
    }
    startTyping(link) {
        const userId = link.state.ilinkUserId;
        if (!userId)
            return () => undefined;
        let tickets = this.tickets.get(link.bindingId);
        if (tickets === undefined) {
            tickets = new TypingTickets();
            this.tickets.set(link.bindingId, tickets);
        }
        return startTyping({
            baseUrl: this.apiBase(link),
            userId,
            contextToken: link.state.contextToken,
            token: () => link.token(),
            warn: message => link.logger.warn(message),
        }, tickets, this.typingTiming);
    }
    /** Forget per-account caches when a binding goes away. */
    forget(bindingId) {
        this.tickets.delete(bindingId);
    }
    /** The account's API host: the one iLink assigned at login, else the default. */
    apiBase(link) {
        return link.state.baseUrl || this.baseUrl;
    }
}
