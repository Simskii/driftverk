import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

const bodylessStatuses = new Set([204, 205, 304]);

function responseHeaders(headers: Record<string, string | string[] | undefined>) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((item) => result.append(name, item));
    else if (value !== undefined) result.append(name, value);
  }
  return result;
}

/**
 * Fetches a CIMD document with public-address validation and connection pinning.
 * The custom lookup supports Node's `all: true` callback form, which the
 * upstream Better Auth 1.7.2 Node transport does not currently handle.
 */
export async function fetchClientMetadataResource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const webRequest = new Request(input, init);
  const url = new URL(webRequest.url);
  if (url.protocol !== "https:") throw new TypeError("CIMD metadata must use HTTPS");
  if (webRequest.method !== "GET" && webRequest.method !== "HEAD") throw new TypeError("CIMD metadata supports only GET and HEAD");

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new TypeError("CIMD hostname returned no DNS addresses");
  if (addresses.some(({ address }) => !isPublicRoutableHost(address)))
    throw new TypeError("CIMD hostname must resolve only to public-routable addresses");
  const pinnedAddress = addresses[0]!;
  const headers = Object.fromEntries(webRequest.headers.entries());
  headers.host = url.host;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal);
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) callback(null, [pinnedAddress]);
    else callback(null, pinnedAddress.address, pinnedAddress.family);
  };

  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      agent: false,
      headers,
      method: webRequest.method,
      servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 ? url.hostname : undefined,
      signal,
      lookup: pinnedLookup,
    }, (incoming) => {
      const status = incoming.statusCode ?? 500;
      const body = webRequest.method === "HEAD" || bodylessStatuses.has(status)
        ? null
        : Readable.toWeb(incoming);
      resolve(new Response(body as BodyInit | null, {
        headers: responseHeaders(incoming.headers),
        status,
        statusText: incoming.statusMessage ?? "",
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
