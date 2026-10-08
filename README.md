# Traffic Meter

Firefox extension that measures live and cumulative traffic for the domains and IPs you choose, filtered by port and Firefox container. Per-site totals, live rate, 60-second sparkline. All data stays local.

## Features

- **Per-target metering.** One card per rule: host pattern, optional port filter, optional container filter.
- **Live and cumulative.** Running totals (down / up) plus current rate and sparkline.
- **Port filtering.** Include or exclude lists. Default ports resolve to 80 / 443.
- **Container filtering.** Include or exclude any Firefox container, plus Default and Private.
- **Two counting modes.** Exact stream bytes, or `Content-Length` headers.
- **Zero footprint on non-matching traffic.** Requests that match no rule are not touched.
- **Persistent.** Rules and totals survive restarts. A `REC` badge shows when recording.
- **Detachable.** Open the UI in a movable window.

## Install

Download `traffic-meter.xpi` from the [latest release](../../releases/latest) and open it in Firefox.

### From source

```sh
git clone https://github.com/<user>/Traffic-Meter.git
```

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** and select `manifest.json`

Temporary add-ons are removed on restart. Build a package with [`web-ext`](https://github.com/mozilla/web-ext):

```sh
npx web-ext build
```

## Usage

1. Click the toolbar icon.
2. Enter a target and press **Add**: `example.com`, `203.0.113.7`, or `example.com:8080`.
3. Press **Start**.
4. Use the gear on a card to edit the pattern, ports and containers, reset its counter, or delete it.

### Rule matching

| Field      | Behavior                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| Domain/IP  | Case-insensitive substring match on the hostname. `cdn.org` matches `a.cdn.org`. |
| Ports      | Empty matches all. Otherwise *only these* or *everything except*.         |
| Containers | None selected matches all. Otherwise *only these* or *everything except*. |

A request counts toward every rule it matches.

### Counting modes

| Mode        | Method                                                                 | Notes                                                       |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Exact**   | Counts response bytes through `webRequest.filterResponseData`.         | Falls back to headers for compressed responses with a known `Content-Length`, so the figure reflects wire size. |
| **Headers** | Uses the `Content-Length` response header.                             | Cheaper. Chunked responses with no length report body size as 0. |

Both modes add status line and header sizes. Upload is request line + headers + `Content-Length`.

## Accuracy

Figures are application-layer estimates, not interface counters.

- TLS, TCP/IP and DNS overhead are excluded.
- Responses served from cache are not counted.
- WebSocket frames are not counted; only the handshake is.
- Upload body size is taken from `Content-Length`; chunked uploads are undercounted.
- Header sizes are computed from parsed header lists, not raw wire bytes. HTTP/2 and HTTP/3 header compression is not modeled.

## Permissions

| Permission              | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `webRequest`, `webRequestBlocking` | Observe requests and attach response stream filters. |
| `<all_urls>`            | Match user-defined targets on any host.                  |
| `storage`               | Persist rules, totals and settings locally.              |
| `contextualIdentities`  | Read container names for the filter UI.                  |

No network requests are made by the extension. No data leaves the browser.

## Compatibility

Firefox 91+. Manifest V2.

## Project layout

```
manifest.json    Extension manifest
background.js    Matching, counting, persistence, message API
popup.html/js/css  UI
icon.svg         Icon
```
