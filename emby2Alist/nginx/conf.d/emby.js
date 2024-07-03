// author: @bpking  https://github.com/bpking1/embyExternalUrl
// 查看日志: "docker logs -f -n 10 nginx-emby 2>&1 | grep js:"
// docker logs -f -n 10 自己的容器名称 2>&1 | grep js:
// 正常情况下此文件所有内容不需要更改

import config from "./constant.js";
import util from "./common/util.js";
import events from "./common/events.js";
import embyApi from "./api/emby-api.js";

async function redirect2Pan(r) {
  events.njsOnExit(`redirect2Pan: ${r.uri}`);

  const ua = r.headersIn["User-Agent"];
  r.warn(`redirect2Pan, UA: ${ua}`);

  // check route cache
  const routeCacheConfig = config.routeCacheConfig;
  if (routeCacheConfig.enable) {
    // webClient download only have itemId on pathParam
    let cacheKey = util.parseExpression(r, routeCacheConfig.keyExpression) ?? r.uri;
    r.log(`redirect2Pan cacheKey: ${cacheKey}`);
    let routeDictKey;
    let cachedLink;
    for (let index = 1; index < 3; index++) {
      routeDictKey = `routeL${index}Dict`;
      cachedLink = ngx.shared[routeDictKey].get(cacheKey);
      if (!cachedLink) {
        // 115 must use ua
        cachedLink = ngx.shared[routeDictKey].get(`${cacheKey}:${ua}`);
      }
      if (!!cachedLink) {
        r.warn(`hit cache ${routeDictKey}: ${cachedLink}`);
        if (cachedLink.startsWith("@")) {
          // use original link
          return internalRedirect(r, cachedLink, routeDictKey);
        } else {
          return redirect(r, cachedLink, routeDictKey);
        }
      } else {
        r.log(`not found from cache ${routeDictKey}, skip`);
      }
    }
  }

  // fetch mount emby/jellyfin file path
  const itemInfo = util.getItemInfo(r);
  r.warn(`itemInfoUri: ${itemInfo.itemInfoUri}`);
  let embyRes = await util.cost(fetchEmbyFilePath,
      itemInfo.itemInfoUri,
      itemInfo.itemId,
      itemInfo.Etag,
      itemInfo.mediaSourceId);
  r.log(`embyRes: ${JSON.stringify(embyRes)}`);
  if (embyRes.message.startsWith("error")) {
    r.error(`fail to fetch fetchEmbyFilePath: ${embyRes.message},fallback use original link`);
    return internalRedirect(r);
  }

  // strm file internal text maybe encode
  r.warn(`notLocal: ${embyRes.notLocal}`);
  if (embyRes.notLocal) {
    embyRes.path = decodeURIComponent(embyRes.path);
    r.warn(`notLocal decodeURIComponent embyRes.path`);
  }

  // check symlinkRule
  const symlinkRule = config.symlinkRule;
  if (symlinkRule && symlinkRule.length > 0) {
    const hitRule = symlinkRule.find(rule => util.strMatches(rule[0], embyRes.path, rule[1]));
    if (hitRule) {
      r.warn(`hit symlinkRule: ${JSON.stringify(hitRule)}`);
      const realpath = util.checkAndGetRealpathSync(embyRes.path);
      if (realpath) {
        r.warn(`symlinkRule realpath overwrite pre: ${embyRes.path}`);
        embyRes.path = realpath;
      }
    }
  }
  r.warn(`mount emby file path: ${embyRes.path}`);

  // routeRule, must before mediaPathMapping
  const routeMode = util.getRouteMode(r, embyRes.path, false, embyRes.notLocal);
  r.warn(`getRouteMode: ${routeMode}`);
  if (util.ROUTE_ENUM.proxy == routeMode) {
    // use original link
    return internalRedirect(r);
  } else if (util.ROUTE_ENUM.block == routeMode) {
    return r.return(403, "blocked");
  }

  let mediaPathMapping = config.mediaPathMapping;
  config.mediaMountPath.map(s => {
    if (!!s) {
      mediaPathMapping.unshift([0, 0 , s, ""]);
    }
  });
  r.warn(`mediaPathMapping: ${JSON.stringify(mediaPathMapping)}`);
  let mediaItemPath = embyRes.path;
  mediaPathMapping.map(arr => {
    if ((arr[1] == 0 && embyRes.notLocal)
      || (arr[1] == 1 && (!embyRes.notLocal))
      || (arr[1] == 2 && (!embyRes.notLocal))) {
        return;
    }
    mediaItemPath = util.strMapping(arr[0], mediaItemPath, arr[2], arr[3]);
  });
  // windows filePath to URL path, warn: markdown log text show \\ to \
  if (mediaItemPath.startsWith("\\")) {
    r.warn(`windows filePath to URL path \\ => /`);
    mediaItemPath = mediaItemPath.replaceAll("\\", "/");
  }
  r.warn(`mapped emby file path: ${mediaItemPath}`);

  // strm file inner remote link redirect,like: http,rtsp
  r.warn(`fetch fetchDirectPathApi 302 url`);
  try {
    r.warn("http://127.0.0.1:5115?path=" + encodeURI(mediaItemPath) + "&ua=" + ua)
    const response = await ngx.fetch("http://127.0.0.1:5115?path=" + encodeURI(mediaItemPath) + "&ua=" + ua, {
      method: "GET",
      max_response_body_size: 65536, // bytes, default 32KB this is 64KB
    });
    if (response.ok) {
      const result = await response.json();
      r.warn(`fetchDirectPathApi result: ${JSON.stringify(result)}`)
      if (result === null || result === undefined) {
        return internalRedirect(r);
      }
      if (result.code == "302") {
        if (result.data) {
          mediaItemPath = result.data;
        }
         return internalRedirect(r);
        // return `error: fetchDirectPathApi ${result.code} ${result.data}`;
      }

      // return `error: fetchDirectPathApi ${result.code} ${result.data}`;
         return internalRedirect(r);
    } else {

      // return `error: fetchDirectPathApi ${response.status} ${response.statusText}`;
       return internalRedirect(r);
    }
  } catch (error) {
    r.warn(`error direct_path_api ${error}`);
     return internalRedirect(r);
  }

  // let directUrl = await fetchDirectPathApi(mediaItemPath, ua);
  // if (!directUrl.startsWith("error")) {
  //   mediaItemPath = directUrl;
  // } else {
  //   return internalRedirect(r);
  // }
  return redirect(r, mediaItemPath);
}

// 拦截 PlaybackInfo 请求
async function transferPlaybackInfo(r) {
  events.njsOnExit(`transferPlaybackInfo: ${r.uri}`);

  let start = Date.now();
  // replay the request
  const proxyUri = util.proxyUri(r.uri);
  r.warn(`playbackinfo proxy uri: ${proxyUri}`);
  const query = util.generateUrl(r, "", "").substring(1);
  r.warn(`playbackinfo proxy query string: ${query}`);
  const response = await r.subrequest(proxyUri, {
    method: r.method,
    args: query
  });
  const isPlayback = r.args.IsPlayback === "true";
  if (response.status === 200) {
    const body = JSON.parse(response.responseText);
    if (body.MediaSources && body.MediaSources.length > 0) {
      r.log(`main request headersOut: ${JSON.stringify(r.headersOut)}`);
      r.log(`subrequest headersOut: ${JSON.stringify(response.headersOut)}`);
      r.warn(`origin playbackinfo: ${response.responseText}`);
      const transcodeConfig = config.transcodeConfig; // routeRule
      const routeCacheConfig = config.routeCacheConfig;
      for (let i = 0; i < body.MediaSources.length; i++) {
        const source = body.MediaSources[i];
        // if (source.IsRemote) {
        //   // live streams are not blocked
        //   // return r.return(200, response.responseText);
        // }
        // 防止客户端转码（转容器）
        modifyDirecPlaySupports(source, true);

        const isStrm = (!source.IsRemote && source.MediaStreams.length == 0) // strm inner local path
          || (source.IsRemote && !source.IsInfiniteStream) // strm after first playback
          || source.Container == "strm"; // strm before first playback
        const notLocal = source.IsRemote || isStrm;
        // routeRule
        source.XRouteMode = util.ROUTE_ENUM.redirect; // for debug
        if (transcodeConfig.enable) {
          const routeMode = util.getRouteMode(r, source.Path, false, notLocal);
          r.warn(`playbackinfo routeMode: ${routeMode}`);
          source.XRouteMode = routeMode; // for debug
          if (util.ROUTE_ENUM.redirect == routeMode) {
            if (!transcodeConfig.redirectTransOptEnable) source.SupportsTranscoding = false;
            // 1. first priority is user clients choice video bitrate < source.Bitrate
            // 2. strict cover routeMode, do't use r.args.StartTimeTicks === "0"
            // 3. source.TranscodingUrl is important, sometimes SupportsTranscoding true but it's empty
            if (
              (transcodeConfig.enableStrmTranscode || !isStrm)
              && source.SupportsTranscoding && source.TranscodingUrl
              && (
                // https://dev.emby.media/reference/pluginapi/MediaBrowser.Model.Session.TranscodeReason.html
                source.TranscodingUrl.includes("TranscodeReasons=ContainerBitrateExceedsLimit")
                ? parseInt(r.args.MaxStreamingBitrate) < source.Bitrate
                : true
              )
            ) {
              r.warn(`client reported and server judgment to transcode, cover routeMode`);
              source.XRouteMode = util.ROUTE_ENUM.transcode; // for debug
              modifyDirecPlaySupports(source, false);
              continue;
            }
          } else if (util.ROUTE_ENUM.transcode == routeMode) {
            r.warn(`routeMode modify playback supports`);
            // because clients prefer SupportsDirectPlay > SupportsDirectStream > SupportsTranscoding
            modifyDirecPlaySupports(source, false);
            continue;
          } else if (util.ROUTE_ENUM.block == routeMode) {
            return r.return(403, "blocked");
          }
          // util.ROUTE_ENUM.proxy == routeMode, because subdivided transcode, proxy do't modify
        } else {
          source.SupportsTranscoding = false;
          if (!transcodeConfig.redirectTransOptEnable) {
            r.warn(`transcodeConfig.enable && redirectTransOptEnable all false, remove origin transcode var`);
            delete source.TranscodingUrl;
            delete source.TranscodingSubProtocol;
            delete source.TranscodingContainer;
          }
        }

        r.warn(`modify direct play info`);
        modifyDirecPlayInfo(r, source, body.PlaySessionId);

        // async cachePreload
        if (routeCacheConfig.enable && routeCacheConfig.enableL2
          && !isPlayback && !source.DirectStreamUrl.includes(".m3u")) {
          cachePreload(r, `${util.getCurrentRequestUrlPrefix(r)}/emby${source.DirectStreamUrl}`, util.CHCHE_LEVEL_ENUM.L2);
        }
      }

      util.copyHeaders(response.headersOut, r.headersOut);
      const jsonBody = JSON.stringify(body);
      r.headersOut["Content-Type"] = "application/json;charset=utf-8";
      let end = Date.now();
      r.warn(`${end - start}ms, transfer playbackinfo: ${jsonBody}`);
      return r.return(200, jsonBody);
    }
  }
  r.warn("playbackinfo subrequest failed");
  return internalRedirect(r);
}

function modifyDirecPlayInfo(r, source, playSessionId) {
  source.XOriginDirectStreamUrl = source.DirectStreamUrl; // for debug
  let localtionPath = source.IsInfiniteStream ? "master" : "stream";
  const fileExt = source.IsInfiniteStream
    && (!source.Container || source.Container === "hls")
    ? "m3u8" : source.Container;
  let streamPart = `${localtionPath}.${fileExt}`;
  // only not live check use real filename
  if (!source.IsInfiniteStream && config.streamConfig.useRealFileName) {
    // origin link: /emby/videos/401929/stream.xxx?xxx
    // modify link: /emby/videos/401929/stream/xxx.xxx?xxx
    // this is not important, hit "/emby/videos/401929/" path level still worked
    streamPart = `${localtionPath}/${util.getFileNameByPath(source.Path)}`;
  }
  source.DirectStreamUrl = util.addDefaultApiKey(
    r,
    util
      .generateUrl(r, "", r.uri, ["StartTimeTicks"])
      // official clients hava /emby virtual path, like fileball not hava, both worked
      .replace(/^.*\/items/i, "/videos")
      .replace("PlaybackInfo", streamPart)
  );
  source.DirectStreamUrl = util.appendUrlArg(
    source.DirectStreamUrl,
    "MediaSourceId",
    source.Id
  );
  source.DirectStreamUrl = util.appendUrlArg(
    source.DirectStreamUrl,
    "PlaySessionId",
    playSessionId
  );
  source.DirectStreamUrl = util.appendUrlArg(
    source.DirectStreamUrl,
    "Static",
    "true"
  );
  // a few players not support special character
  source.DirectStreamUrl = encodeURI(source.DirectStreamUrl);
  source.XModifyDirectStreamUrlSuccess = true; // for debug
}

function modifyDirecPlaySupports(source, flag) {
  source.SupportsDirectPlay = flag;
  source.SupportsDirectStream = flag;
  let msg = `modify direct play supports all ${flag}`;
  if (!flag && source.TranscodingUrl) {
    source.TranscodingUrl = util.appendUrlArg(
      source.TranscodingUrl,
      util.ARGS.useProxyKey,
      "1"
    );
    source.XModifyTranscodingUrlSuccess = true; // for debug
    msg += ", and add useProxyKey"
  }
  ngx.log(ngx.WARN, msg);
}

async function fetchEmbyFilePath(itemInfoUri, itemId, Etag, mediaSourceId) {
  let rvt = {
    message: "success",
    path: "",
    itemName: "",
    notLocal: false,
  };
  try {
    const res = await ngx.fetch(itemInfoUri, {
      method: "GET",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "Content-Length": 0,
      },
      max_response_body_size: 8388608, // bytes, default 32KB this is 8MB
    });
    if (res.ok) {
      const result = await res.json();
      if (!result) {
        rvt.message = `error: emby_api itemInfoUri response is null`;
        return rvt;
      }
      if (itemInfoUri.includes("JobItems")) {
        const jobItem = result.Items.find(o => o.Id == itemId);
        if (jobItem) {
          // "MediaType": "Photo"... not have "MediaSources" field
          rvt.path = jobItem.OutputPath;
          // live stream not support download, can ignore it
          rvt.notLocal = util.checkIsStrmByPath(jobItem.OutputPath);
        } else {
          rvt.message = `error: emby_api /Sync/JobItems response is null`;
          return rvt;
        }
      } else {
        const item = result.Items[0];
        if (!item) {
          rvt.message = `error: emby_api /Items response is null`;
          return rvt;
        }
        if (item.MediaSources) {
          let mediaSource = item.MediaSources[0];
          // ETag only on Jellyfin
          if (Etag) {
            mediaSource = item.MediaSources.find((m) => m.ETag == Etag);
          }
          // item.MediaSources on Emby has one, on Jellyfin has many!
          if (mediaSourceId) {
            mediaSource = item.MediaSources.find((m) => m.Id == mediaSourceId);
          }
          rvt.path = mediaSource.Path;
          rvt.itemName = item.Name;
          /**
           * note1: MediaSourceInfo{ Protocol }, String ($enum)(File, Http, Rtmp, Rtsp, Udp, Rtp, Ftp, Mms)
           * note2: live stream "IsInfiniteStream": true
           * eg1: MediaSourceInfo{ IsRemote }: true
           * eg1: MediaSourceInfo{ IsRemote }: false, but MediaSourceInfo{ Protocol }: File, this is scraped
           */
          rvt.notLocal = mediaSource.IsInfiniteStream
            || mediaSource.IsRemote
            || util.checkIsStrmByPath(item.Path);
        } else {
          // "MediaType": "Photo"... not have "MediaSources" field
          rvt.path = item.Path;
        }
      }
      return rvt;
    } else {
      rvt.message = `error: emby_api ${res.status} ${res.statusText}`;
      return rvt;
    }
  } catch (error) {
    rvt.message = `error: emby_api fetch mediaItemInfo failed, ${error}`;
    return rvt;
  }
}

async function itemsFilter(r) {
  events.njsOnExit(`itemsFilter: ${r.uri}`);

  r.variables.request_uri += "&Fields=Path";
  // util.appendUrlArg(r.variables.request_uri, "Fields", "Path");
  const subR = await r.subrequest(util.proxyUri(r.uri), {
    method: r.method,
  });
  let body;
  if (subR.status === 200) {
  	body = JSON.parse(subR.responseText);
  } else {
  	r.warn("itemsFilter subrequest failed");
	  return internalRedirect(r);
  }
  const itemHiddenRule = config.itemHiddenRule;
  if (itemHiddenRule && itemHiddenRule.length > 0) {
    r.warn(`itemsFilter before: ${body.Items.length}`);

    const flag = r.variables.flag;
    r.warn(`itemsFilter flag: ${flag}`);
    let mainItemPath;
    if (flag == "itemSimilar") {
      // fetch mount emby/jellyfin file path
      const itemInfo = util.getItemInfo(r);
      r.warn(`itemSimilarInfoUri: ${itemInfo.itemInfoUri}`);
      const embyRes = await util.cost(fetchEmbyFilePath,
        itemInfo.itemInfoUri,
        itemInfo.itemId,
        itemInfo.Etag,
        itemInfo.mediaSourceId
      );
      mainItemPath = embyRes.path;
      r.warn(`mainItemPath: ${mainItemPath}`);
    }

    let itemHiddenCount = 0;
    if (body.Items) {
      body.Items = body.Items.filter(item => {
        if (!item.Path) {
          return true;
        }
        return !itemHiddenRule.some(rule => {
          if ((!rule[2] || rule[2] == 0 || rule[2] == 2) && !!mainItemPath
            && util.strMatches(rule[0], mainItemPath, rule[1])) {
            return false;
          }
          if (flag == "searchSuggest" && rule[2] == 2) {
            return false;
          }
          if (flag == "backdropSuggest" && rule[2] == 3) {
            return false;
          }
          // 4: 只隐藏[类型风格]接口,这个暂时分页有 bug,被隐藏掉的项会有个空的海报,第一页后的 StartIndex 需要减去 itemHiddenCount
          // 且最重要是无法得知当前浏览项目,会误伤导致接口返回[],不建议实现该功能
          // if (flag == "genreSearch" && rule[2] == 4) {
          //   return false;
          // }
          if (flag == "itemSimilar" && rule[2] == 1) {
            return false;
          }
          if (util.strMatches(rule[0], item.Path, rule[1])) {
            r.warn(`itemPath hit itemHiddenRule: ${item.Path}`);
            itemHiddenCount++;
            return true;
          }
        });
      });
    }
    r.warn(`itemsFilter after: ${body.Items.length}`);
    r.warn(`itemsFilter itemHiddenCount: ${itemHiddenCount}`);
    if (body.TotalRecordCount) {
      body.TotalRecordCount -= itemHiddenCount;
      r.warn(`itemsFilter TotalRecordCount: ${body.TotalRecordCount}`);
    }
  }

  util.copyHeaders(subR.headersOut, r.headersOut);
  return r.return(200, JSON.stringify(body));
}

async function systemInfoHandler(r) {
  events.njsOnExit(`systemInfoHandler: ${r.uri}`);

  const subR = await r.subrequest(util.proxyUri(r.uri), {
    method: r.method,
  });
  let body;
  if (subR.status === 200) {
  	body = JSON.parse(subR.responseText);
  } else {
  	r.warn(`systemInfoHandler subrequest failed`);
	  return internalRedirect(r);
  }
  const currentPort = parseInt(r.variables.server_port);
  const originPort = parseInt(body.WebSocketPortNumber);
  body.WebSocketPortNumber = currentPort;
  if (body.HttpServerPortNumber) {
    body.HttpServerPortNumber = currentPort;
  }
  if (body.LocalAddresses) {
    body.LocalAddresses.forEach((s, i, arr) => {
      arr[i] = s.replace(originPort, currentPort);
    });
  }
  if (body.RemoteAddresses) {
    body.RemoteAddresses.forEach((s, i, arr) => {
      arr[i] = s.replace(originPort, currentPort);
    });
  }
  // old clients
  if (body.LocalAddress) {
    body.LocalAddress = body.LocalAddress.replace(originPort, currentPort);
  }
  if (body.WanAddress) {
    body.WanAddress = body.WanAddress.replace(originPort, currentPort);
  }
  util.copyHeaders(subR.headersOut, r.headersOut);
  return r.return(200, JSON.stringify(body));
}

async function fetchDirectPathApi(mediaItemPath, ua) {
  r.warn(`fetchDirectPathApi filePath: ${mediaItemPath}, ua: ${ua}`)
  try {
    r.warn("http://127.0.0.1:5115?path=" + encodeURI(mediaItemPath) + "&ua=" + ua)
    const response = await ngx.fetch("http://127.0.0.1:5115?path=" + encodeURI(mediaItemPath) + "&ua=" + ua, {
      method: "GET",
      max_response_body_size: 65536, // bytes, default 32KB this is 64KB
    });
    r.warn(`fetchDirectPathApi response: ${response} ${response.ok} ${response.status}`);
    if (response.ok) {
      const result = await response.json();
      if (result === null || result === undefined) {
        return `error: fetchDirectPathApi response is null`;
      }
      if (result.code == "0") {
        if (result.data) {
          return result.data;
        }
        return `error: fetchDirectPathApi ${result.code} ${result.data}`;
      }

      return `error: fetchDirectPathApi ${result.code} ${result.data}`;
    } else {
      return `error: fetchDirectPathApi ${response.status} ${response.statusText}`;
    }
  } catch (error) {
    r.warn(`error direct_path_api ${error}`);
    return `error: direct_path_api ${error}`;
  }
}


async function sendMessage2EmbyDevice(deviceId, header, text, timeoutMs) {
  if (!deviceId) {
    ngx.log(ngx.WARN, `warn: sendMessage2EmbyDevice: deviceId is required, skip`);
    return;
  }
  embyApi.fetchSessions(config.embyHost, config.embyApiKey, {DeviceId:deviceId}).then(sessionResPromise => {
    if (sessionResPromise.status !== 200) {
      ngx.log(ngx.WARN, `warn: sendMessage2EmbyDevice sessionRes.status: ${sessionResPromise.status}`);
      return;
    }
    sessionResPromise.json().then(sessionRes => {
      if (!sessionRes || (!!sessionRes && sessionRes.length == 0)) {
        ngx.log(ngx.WARN, `warn: sendMessage2EmbyDevice: fetchSessions: session not found, skip`);
        return;
      }
      // sometimes have multiple sessions
      const targetSession = sessionRes.filter(s => s.SupportsRemoteControl)[0];
      if (targetSession) {
        embyApi.fetchSessionsMessage(targetSession.Id, header, text, timeoutMs);
      } else {
        ngx.log(ngx.WARN, `warn: sendMessage2EmbyDevice: targetSession not found, skip`);
      }
    }).catch((error) => {
      ngx.log(ngx.WARN, `warn: sendMessage2EmbyDevice: ${error}, skip`);
    });
  }).catch((error) => {
    ngx.log(ngx.WARN, `warn: sendMessage2EmbyDevice: ${error}, skip`);
  });
}

async function cachePreload(r, url, cacheLevel) {
  url = util.appendUrlArg(url, util.ARGS.cacheLevleKey, cacheLevel);
  ngx.log(ngx.WARN, `cachePreload Level: ${cacheLevel}`);
  preload(r, url);
}

async function preload(r, url) {
  events.njsOnExit(`preload`);

  url = util.appendUrlArg(url, util.ARGS.internalKey, "1");
  const ua = r.headersIn["User-Agent"];
  ngx.fetch(url, {
    method: "HEAD",
    headers: {
      "User-Agent": ua,
    },
    max_response_body_size: 1024
  }).then(res => {
    ngx.log(ngx.WARN, `preload response.status: ${res.status}`);
    if ((res.status > 300 && res.status < 309) || res.status == 200) {
      ngx.log(ngx.WARN, `success: preload used UA: ${ua}, url: ${url}`);
    } else {
      ngx.log(ngx.WARN, `error: preload, skip`);
    }
  }).catch((error) => {
    ngx.log(ngx.ERR, `error: preload: ${error}`);
  });
}

async function redirectAfter(r, url, cachedRouteDictKey) {
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    let cachedMsg = "";
    const routeCacheConfig = config.routeCacheConfig;
    if (routeCacheConfig.enable) {
      const ua = r.headersIn["User-Agent"];
      // webClient download only have itemId on pathParam
      let cacheKey = util.parseExpression(r, routeCacheConfig.keyExpression) ?? r.uri;
      cacheKey = url.includes(config.strHead["115"]) ? `${cacheKey}:${ua}` : cacheKey;
      r.log(`redirectAfter cacheKey: ${cacheKey}`);
      // cachePreload added args in url
      const cacheLevle = r.args[util.ARGS.cacheLevleKey] ?? util.CHCHE_LEVEL_ENUM.L1;
      let flag = !ngx.shared["routeL2Dict"].has(cacheKey);
        // && !ngx.shared["routeL3Dict"].has(cacheKey);
      let routeDictKey = "routeL1Dict";
      if (util.CHCHE_LEVEL_ENUM.L2 === cacheLevle) {
        routeDictKey = "routeL2Dict";
        flag = !ngx.shared["routeL1Dict"].has(cacheKey);
      // } else if (util.CHCHE_LEVEL_ENUM.L3 === cacheLevle) {
      //   routeDictKey = "routeL3Dict";
      //   flag = !ngx.shared["routeL1Dict"].has(cacheKey) && !ngx.shared["routeL2Dict"].has(cacheKey);
      }
      if (flag) {
        util.dictAdd(routeDictKey, cacheKey, url);
        cachedMsg += `cache ${routeDictKey} added, `;
      }
      cachedMsg = cachedRouteDictKey ? `hit cache ${cachedRouteDictKey}, ` : cachedMsg;
    }

    const deviceId = util.getDeviceId(r.args);
    const idemVal = ngx.shared.idemDict.get(deviceId);
    if (config.embyNotificationsAdmin.enable && !idemVal) {
      embyApi.fetchNotificationsAdmin(
        config.embyNotificationsAdmin.name,
        config.embyNotificationsAdmin.includeUrl ?
        `${cachedMsg}original link: ${r.uri}\nredirect to: ${url}` :
        `${cachedMsg}redirect: success`
      );
      util.dictAdd("idemDict", deviceId, "1");
    }

    if (config.embyRedirectSendMessage.enable && !idemVal) {
      sendMessage2EmbyDevice(deviceId,
        config.embyRedirectSendMessage.header,
        `${cachedMsg}redirect: success`,
        config.embyRedirectSendMessage.timeoutMs);
      util.dictAdd("idemDict", deviceId, "1");
    }
  } catch (error) {
    r.error(`error: redirectAfter: ${error}`);
  }
}

async function internalRedirectAfter(r, uri, cachedRouteDictKey) {
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    let cachedMsg = "";
    const routeCacheConfig = config.routeCacheConfig;
    if (routeCacheConfig.enable) {
      cachedMsg = `hit routeCache L1: ${!!cachedRouteDictKey}, `;
      // webClient download only have itemId on pathParam
      const cacheKey = util.parseExpression(r, routeCacheConfig.keyExpression) ?? r.uri;
      util.dictAdd("routeL1Dict", cacheKey, uri);
    }

    const deviceId = util.getDeviceId(r.args);
    const idemVal = ngx.shared.idemDict.get(deviceId);
    const msgPrefix = `${cachedMsg}use original link: `;
    if (config.embyNotificationsAdmin.enable && !idemVal) {
      embyApi.fetchNotificationsAdmin(
        config.embyNotificationsAdmin.name,
        config.embyNotificationsAdmin.includeUrl ?
        msgPrefix + r.uri :
        `${msgPrefix}success`
      );
      util.dictAdd("idemDict", deviceId, "1");
    }

    if (config.embyRedirectSendMessage.enable && !idemVal) {
      sendMessage2EmbyDevice(deviceId,
        config.embyRedirectSendMessage.header,
        `${msgPrefix}success`,
        config.embyRedirectSendMessage.timeoutMs);
      util.dictAdd("idemDict", deviceId, "1");
    }
  } catch (error) {
    r.error(`error: internalRedirectAfter: ${error}`);
  }
}

function redirect(r, url, cachedRouteDictKey) {
  r.warn(`redirect to: ${url}`);
  // need caller: return;
  r.return(302, url);

  // async
  redirectAfter(r, url, cachedRouteDictKey);
}

function internalRedirect(r, uri, cachedRouteDictKey) {
  if (!uri) {
    uri = "@root";
    r.warn(`use original link`);
  }
  r.log(`internalRedirect to: ${uri}`);
  // need caller: return;
  r.internalRedirect(uri);

  // async
  internalRedirectAfter(r, uri, cachedRouteDictKey);
}

function internalRedirectExpect(r, uri) {
  if (!uri) {
    uri = "@root";
  }
  r.log(`internalRedirect to: ${uri}`);
  // need caller: return;
  r.internalRedirect(uri);
}

export default {
  redirect2Pan,
  fetchEmbyFilePath,
  transferPlaybackInfo,
  itemsFilter,
  systemInfoHandler,
  redirect,
  internalRedirect,
  internalRedirectExpect,
};
