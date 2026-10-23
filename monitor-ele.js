#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_URL = 'https://www.prcboard.com/eele-results-october-2026-electronics-engineering-licensure-exam-list-of-passers';
const DIR = __dirname;
const ENV_FILE = path.join(DIR, '.env');
const TXT_FILE = path.join(DIR, 'passers-g.txt');
const JSON_FILE = path.join(DIR, 'passers-g.json');
const LOG_FILE = path.join(DIR, 'monitor.log');
const MIN_PASSERS = 200;
const TELEGRAM_LIMIT = 3500;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SURNAME_RE = /^[\p{L}][\p{L}\p{M}.'\u2019\- ]*$/u;

function readEnv(file = ENV_FILE) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2
      && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function getEnv() {
  return { ...process.env, ...readEnv() };
}

function config() {
  const e = getEnv();
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    pageUrl: (e.PAGE_URL || DEFAULT_URL).trim(),
    prefix: (e.SURNAME_PREFIX || 'G').trim().toUpperCase(),
    pollMs: Math.max(10, num(e.POLL_SECONDS, 120)) * 1000,
    heartbeatMs: Math.max(30, num(e.HEARTBEAT_SECONDS, 600)) * 1000,
    forceFetchMs: Math.max(60, num(e.FORCE_FETCH_SECONDS, 300)) * 1000,
    maxHours: num(e.MAX_HOURS, 24),
    stateFile: path.resolve(DIR, (e.SENT_STATE_FILE || 'sent-state.json').trim()),
  };
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // logging must never stop the monitor
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&mdash;/gi, '-')
    .replace(/&lsquo;|&rsquo;|&#0?39;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function htmlToLines(html) {
  const article = html.match(/<article\b[\s\S]*?<\/article>/i);
  let text = article ? article[0] : html;
  text = text.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|td|h[1-6]|section|article|blockquote)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function parsePassers(html) {
  const lines = htmlToLines(html);
  const rollAt = lines.findIndex((line) => /Roll of Successful Examinees/i.test(line));
  const scoped = rollAt >= 0 ? lines.slice(rollAt + 1) : lines;
  const passers = [];
  let lastSeq = 0;

  for (const line of scoped) {
    if (/^(comments?|\d+ comments?|leave a (reply|comment))\b/i.test(line)) break;
    const match = line.match(/^(\d{1,4})[.)]?\s+(.+?),\s*(.{2,})$/);
    if (!match) continue;
    const seq = Number(match[1]);
    if (seq <= lastSeq) break;
    const surname = match[2].replace(/\s+/g, ' ').trim();
    const given = match[3].replace(/\s+/g, ' ').trim();
    if (!SURNAME_RE.test(surname)) continue;
    passers.push({ seq, surname, given });
    lastSeq = seq;
  }

  passers.sort((a, b) => a.seq - b.seq);
  const complete = passers.length >= MIN_PASSERS
    && passers[passers.length - 1].seq === passers.length;
  return { passers, complete };
}

function signature(passers) {
  const hash = crypto.createHash('sha1').update(JSON.stringify(passers)).digest('hex');
  const last = passers[passers.length - 1] || {};
  return `${passers.length}:${last.seq || 0}:${hash}`;
}

async function fetchPage(pageUrl, options = {}) {
  const url = new URL(pageUrl);
  if (options.bustCache) url.searchParams.set('_prcb', String(Date.now()));
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  };
  if (options.ifModifiedSince) headers['if-modified-since'] = options.ifModifiedSince;

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
    headers,
  });
  if (res.status === 304) {
    return { status: 304, html: null, lastModified: options.ifModifiedSince || null };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (/cf-browser-verification|challenge-platform|<title>\s*Just a moment/i.test(text)) {
    throw new Error('blocked by an anti-bot challenge');
  }
  return { status: res.status, html: text, lastModified: res.headers.get('last-modified') };
}

async function telegram(method, params = {}) {
  const env = getEnv();
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${data.description || `HTTP ${res.status}`}`);
  }
  return data.result;
}

async function resolveChatId() {
  const configured = (getEnv().TELEGRAM_CHAT_ID || '').trim();
  if (configured) return configured;
  const updates = await telegram('getUpdates', { limit: 100, allowed_updates: ['message'] });
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const message = updates[i].message || updates[i].edited_message;
    if (message && message.chat && message.chat.id) return String(message.chat.id);
  }
  throw new Error('No Telegram chat found. Send any message to your bot in Telegram, then retry.');
}

function chunkText(lines, limit = TELEGRAM_LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildMessages(meta, gPassers) {
  const title = `EELE Oct 2026 · ${meta.prefix} surnames`;
  const summary = `${withCommas(gPassers.length)} of ${withCommas(meta.totalPassers)} passers`;
  const width = gPassers.reduce((widest, p) => Math.max(widest, String(p.seq).length), 0);
  const rows = gPassers.length
    ? gPassers.map((p) => `  ${String(p.seq).padStart(width)}. ${p.surname}, ${p.given}`)
    : ['  No passers with this surname initial.'];
  const chunks = chunkText(rows);
  return chunks.map((chunk, index) => {
    const part = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
    const head = index === 0 ? `${title}${part}\n${summary}` : `${title}${part}`;
    return `${head}\n\n${chunk}`;
  });
}

async function sendList(meta, gPassers) {
  const chatId = await resolveChatId();
  const messages = buildMessages(meta, gPassers);
  for (const message of messages) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    });
  }
  return messages.length;
}

function writeResults(meta, gPassers) {
  const lines = [
    `EELE October 2026 - passers with surname starting with "${meta.prefix}"`,
    `Detected: ${meta.detectedAt}`,
    `Source: ${meta.source}`,
    `Total passers parsed: ${meta.totalPassers}`,
    `Matching passers: ${gPassers.length}`,
    '',
    ...gPassers.map((p) => `${p.seq}\t${p.surname}, ${p.given}`),
    '',
  ];
  fs.writeFileSync(TXT_FILE, lines.join('\n'), 'utf8');
  fs.writeFileSync(JSON_FILE, `${JSON.stringify({ ...meta, passers: gPassers }, null, 2)}\n`, 'utf8');
}

async function checkTelegramSetup() {
  const env = getEnv();
  if (!(env.TELEGRAM_BOT_TOKEN || '').trim()) {
    log('Telegram token not set yet; the list will still be saved locally.');
    return;
  }
  try {
    const me = await telegram('getMe');
    log(`Telegram bot ready: @${me.username}`);
    const chatId = await resolveChatId();
    log(`Telegram chat resolved: ${chatId}`);
  } catch (error) {
    log(`Telegram setup warning: ${error.message}`);
  }
}

async function runOnce(options, cfg) {
  log(`Checking ${cfg.pageUrl}`);
  const { html } = await fetchPage(cfg.pageUrl, { bustCache: true });
  const { passers } = parsePassers(html);
  if (passers.length === 0) {
    log('Results are not on the page yet (no passer names found).');
    return 0;
  }
  const gPassers = passers.filter((p) => p.surname.toUpperCase().startsWith(cfg.prefix));
  const meta = {
    source: cfg.pageUrl,
    prefix: cfg.prefix,
    detectedAt: new Date().toISOString(),
    totalPassers: passers.length,
  };
  writeResults(meta, gPassers);
  log(`Found ${passers.length} passers, ${gPassers.length} matching "${cfg.prefix}". Saved ${TXT_FILE} and ${JSON_FILE}.`);
  if (!options.noSend) {
    try {
      const messages = await sendList(meta, gPassers);
      log(`Sent ${messages} Telegram message(s).`);
    } catch (error) {
      log(`Telegram delivery failed: ${error.message}`);
    }
  }
  return gPassers.length;
}

async function ensureTelegramConfig() {
  const env = getEnv();
  if (!(env.TELEGRAM_BOT_TOKEN || '').trim()) throw new Error('TELEGRAM_BOT_TOKEN secret is missing');
  if (!(env.TELEGRAM_CHAT_ID || '').trim()) throw new Error('TELEGRAM_CHAT_ID secret is missing');
  const me = await telegram('getMe');
  log(`Telegram bot ready: @${me.username}`);
  return me;
}

function readSentState(cfg) {
  if (!fs.existsSync(cfg.stateFile)) return { stateFile: cfg.stateFile, state: null };
  try {
    const state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    if (!state || (state.source && state.source !== cfg.pageUrl)) {
      return { stateFile: cfg.stateFile, state: null };
    }
    return { stateFile: cfg.stateFile, state };
  } catch {
    return { stateFile: cfg.stateFile, state: null };
  }
}

function pageStatus(passers, complete, prefix) {
  if (complete) {
    const count = passers.filter((p) => p.surname.toUpperCase().startsWith(prefix)).length;
    return `Results are live: ${passers.length} passers parsed, ${count} with ${prefix} surnames.`;
  }
  if (passers.length > 0) {
    return `List is appearing (${passers.length} names so far); waiting for it to complete.`;
  }
  return 'Still waiting: no passer names on the page yet.';
}

function manilaTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Manila',
  }).format(date);
}

function manilaClock(date = new Date()) {
  return new Intl.DateTimeFormat('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Manila',
  }).format(date);
}

function withCommas(value) {
  return Number(value).toLocaleString('en-US');
}

function intervalLabel(ms) {
  const minutes = ms / 60000;
  if (minutes < 1) {
    const seconds = Math.round(ms / 1000);
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  }
  const value = Number.isInteger(minutes) ? `${minutes}` : minutes.toFixed(1);
  return `${value} ${Number.parseFloat(value) === 1 ? 'minute' : 'minutes'}`;
}

async function runHeartbeat(cfg) {
  if (readSentState(cfg).state) {
    log('Already delivered; heartbeat skipped.');
    return;
  }

  let status;
  try {
    const { html } = await fetchPage(cfg.pageUrl, { bustCache: true });
    const { passers, complete } = parsePassers(html);
    status = pageStatus(passers, complete, cfg.prefix);
  } catch (error) {
    status = `Could not check the page: ${error.message}. The next run will retry.`;
  }

  const runUrl = (getEnv().GITHUB_RUN_URL || '').trim();
  const message = [
    'EELE monitor heartbeat',
    'GitHub Actions is running normally.',
    `Checked: ${manilaTime()} (Asia/Manila)`,
    `Site checks: every ${intervalLabel(cfg.pollMs)}. Updates: every ${intervalLabel(cfg.heartbeatMs)}.`,
    status,
    runUrl ? `Run details: ${runUrl}` : '',
  ].filter(Boolean).join('\n');

  const chatId = await resolveChatId();
  await telegram('sendMessage', { chat_id: chatId, text: message, disable_web_page_preview: true });
  log(`Heartbeat sent: ${status}`);
}

async function deliverList(cfg, passers, stateFile) {
  const gPassers = passers.filter((p) => p.surname.toUpperCase().startsWith(cfg.prefix));
  const meta = {
    source: cfg.pageUrl,
    prefix: cfg.prefix,
    detectedAt: new Date().toISOString(),
    totalPassers: passers.length,
  };
  writeResults(meta, gPassers);
  log(`Complete list found: ${passers.length} passers, ${gPassers.length} matching "${cfg.prefix}". Saved ${TXT_FILE} and ${JSON_FILE}.`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const messages = await sendList(meta, gPassers);
      fs.writeFileSync(stateFile, `${JSON.stringify({
        source: cfg.pageUrl,
        deliveredAt: meta.detectedAt,
        totalPassers: passers.length,
        matchingPassers: gPassers.length,
      }, null, 2)}\n`, 'utf8');
      log(`Sent ${messages} Telegram message(s) and wrote ${stateFile}.`);
      return true;
    } catch (error) {
      lastError = error;
      log(`Telegram attempt ${attempt}/3 failed: ${error.message}`);
      if (attempt < 3) await sleep(15000);
    }
  }
  log(`Telegram delivery failed after 3 attempts: ${lastError.message}`);
  return false;
}

async function runCloud(cfg) {
  const { state } = readSentState(cfg);
  if (state) {
    log(`Already delivered at ${state.deliveredAt || 'an earlier run'}; nothing to do.`);
    return;
  }

  log(`Checking ${cfg.pageUrl}`);
  const { html } = await fetchPage(cfg.pageUrl, { bustCache: true });
  const { passers, complete } = parsePassers(html);
  if (passers.length === 0) {
    log('Results are not on the page yet (no passer names found).');
    return;
  }
  if (!complete) {
    log(`List is present but incomplete (${passers.length} names); waiting for the next run.`);
    return;
  }

  const delivered = await deliverList(cfg, passers, cfg.stateFile);
  if (!delivered) throw new Error('Telegram delivery failed after 3 attempts');
}

function jitterMs() {
  return Math.round(Math.random() * 4000) - 2000;
}

async function runLive(cfg) {
  const { state } = readSentState(cfg);
  if (state) {
    log(`Already delivered at ${state.deliveredAt || 'an earlier run'}; live monitor exiting.`);
    return;
  }

  const deadline = Date.now() + cfg.maxHours * 3600 * 1000;
  const watch = `checking every ${intervalLabel(cfg.pollMs)}`;
  const alerted = new Set();
  let lastModified = null;
  let lastStatus = 'The first page check has not finished yet.';
  let shortStatus = `Not released yet · ${watch}`;
  let lastCheckedAt = null;
  let lastSig = null;
  let checks = 0;
  let missingNotices = 0;
  let backoffMs = 0;

  async function sendMessage(text) {
    const chatId = await resolveChatId();
    await telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  }

  async function alertOnce(key, title, body, withLink = false) {
    if (key !== null && alerted.has(key)) return;
    if (key !== null) alerted.add(key);
    const text = [
      `EELE Oct 2026 · ${manilaClock(lastCheckedAt || new Date())}`,
      title,
      body,
      withLink ? cfg.pageUrl : '',
    ].filter(Boolean).join('\n');
    try {
      await sendMessage(text);
      log(`Alert sent: ${title}`);
    } catch (error) {
      if (key !== null) alerted.delete(key);
      log(`Alert failed (${title}): ${error.message}`);
    }
  }

  async function ping() {
    if (readSentState(cfg).state) return true;
    try {
      await sendMessage(`EELE Oct 2026 · ${manilaClock(lastCheckedAt || new Date())}\n${shortStatus}`);
      log(`Ping sent after ${checks} check(s): ${lastStatus}`);
      return true;
    } catch (error) {
      log(`Ping failed: ${error.message}`);
      return false;
    }
  }

  async function checkOnce(force) {
    let result;
    try {
      result = await fetchPage(cfg.pageUrl, force ? { bustCache: true } : { ifModifiedSince: lastModified });
    } catch (error) {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 300000) : 60000;
      lastStatus = `Page check failed: ${error.message}`;
      shortStatus = `Checks failing · retrying in ${intervalLabel(backoffMs)}`;
      log(`${lastStatus}. Backing off to ${intervalLabel(backoffMs)}.`);
      await alertOnce('fetch-failing', `CHECKS FAILING · ${error.message}`, `Retrying in ${intervalLabel(backoffMs)}.`);
      return backoffMs;
    }

    if (backoffMs) {
      backoffMs = 0;
      alerted.delete('fetch-failing');
      await alertOnce(null, 'CHECKS RESUMED', `Back to ${watch}.`);
    }

    checks += 1;
    lastCheckedAt = new Date();

    if (result.status === 304) {
      log(`Check ${checks}: page unchanged (304).`);
      return cfg.pollMs;
    }

    lastModified = result.lastModified || lastModified;
    const { passers, complete } = parsePassers(result.html);
    const standby = /Stand by for results/i.test(result.html);
    const sig = passers.length ? signature(passers) : null;
    // A page typo can break the sequence check, so a stable full-size list also counts as final.
    const stable = Boolean(sig) && passers.length >= MIN_PASSERS && sig === lastSig;
    lastSig = sig;

    if (complete || stable) {
      if (!complete) log(`List stable at ${passers.length} names across two checks; treating it as final.`);
      const gCount = passers.filter((p) => p.surname.toUpperCase().startsWith(cfg.prefix)).length;
      await alertOnce('list-complete',
        `RESULTS RELEASED · ${withCommas(passers.length)} passers`,
        `${cfg.prefix} surnames: ${gCount} · sending now`,
        true);
      const delivered = await deliverList(cfg, passers, cfg.stateFile);
      if (delivered) return 'delivered';
      lastStatus = `The full list is live (${passers.length} passers) but Telegram delivery failed; retrying.`;
      shortStatus = `Released · ${withCommas(passers.length)} passers · delivery failed, retrying`;
      log(lastStatus);
      await alertOnce('delivery-failed', 'DELIVERY FAILED · list is ready',
        'Retrying on every check; also saved as a run artifact.');
      return 60000;
    }

    if (passers.length >= MIN_PASSERS) {
      lastStatus = `Found ${passers.length} names; confirming stability on the next check.`;
      shortStatus = `List appearing · ${withCommas(passers.length)} names · confirming`;
    } else if (passers.length > 0) {
      lastStatus = `List is appearing (${passers.length} names so far); waiting for it to complete.`;
      shortStatus = `List appearing · ${withCommas(passers.length)} names so far · ${watch}`;
      missingNotices = 0;
      alerted.delete('format-change');
      await alertOnce('names-appeared',
        `NAMES APPEARING · ${withCommas(passers.length)} so far`,
        `${cfg.prefix} list sends automatically when the roster is complete.`);
    } else if (standby) {
      lastStatus = 'Still "Stand by for results!" - no names yet.';
      shortStatus = `Not released yet · ${watch}`;
      missingNotices = 0;
      alerted.delete('format-change');
    } else {
      lastStatus = 'The standby notice is gone but no passer names parsed yet.';
      shortStatus = `Page changed · no names parsed yet · ${watch}`;
      missingNotices += 1;
      if (missingNotices >= 3) {
        await alertOnce('format-change', 'CANNOT READ THE LIST',
          `Standby notice gone but ${missingNotices} checks in a row parsed no names.`, true);
      }
    }

    log(`Check ${checks}: ${lastStatus}`);
    return cfg.pollMs;
  }

  let nextPoll = Date.now();
  let nextPing = Date.now();
  let nextForce = Date.now();

  while (Date.now() < deadline) {
    if (Date.now() >= nextPoll) {
      const force = Date.now() >= nextForce;
      if (force) nextForce = Date.now() + cfg.forceFetchMs;
      const wait = await checkOnce(force);
      if (wait === 'delivered') return;
      nextPoll = Date.now() + Math.max(1000, wait + jitterMs());
    }

    if (Date.now() >= nextPing) {
      const sent = await ping();
      nextPing = Date.now() + (sent ? cfg.heartbeatMs : 60000);
    }

    if (readSentState(cfg).state) {
      log('Another run marked the list as delivered; live monitor exiting.');
      return;
    }

    const now = Date.now();
    const remaining = deadline - now;
    if (remaining <= 0) break;
    await sleep(Math.max(500, Math.min(Math.min(nextPoll, nextPing) - now, remaining)));
  }

  log(`Live window ended after ${cfg.maxHours} hour(s) without delivering the list.`);
}

async function runMonitor(options, cfg) {
  const deadline = Date.now() + cfg.maxHours * 3600 * 1000;
  let pending = null;
  let missingNotices = 0;
  let formatAlertSent = false;

  while (Date.now() < deadline) {
    let html;
    try {
      ({ html } = await fetchPage(cfg.pageUrl, { bustCache: true }));
    } catch (error) {
      log(`Fetch failed: ${error.message}. Retrying in ${Math.round(cfg.pollMs / 1000)}s.`);
      await sleep(cfg.pollMs);
      continue;
    }

    const { passers } = parsePassers(html);
    const standBy = /Stand by for results/i.test(html);

    if (passers.length === 0) {
      pending = null;
      missingNotices = 0;
      log(standBy
        ? 'Still "Stand by for results!" - no names yet.'
        : 'Page changed but no passer names parsed yet.');
      if (!standBy) formatAlertSent = false;
    } else if (passers.length < MIN_PASSERS) {
      pending = null;
      log(`Only ${passers.length} names found so far; waiting for the complete list.`);
    } else {
      const sig = signature(passers);
      if (pending && pending.sig === sig) {
        const gPassers = passers.filter((p) => p.surname.toUpperCase().startsWith(cfg.prefix));
        const meta = {
          source: cfg.pageUrl,
          prefix: cfg.prefix,
          detectedAt: new Date().toISOString(),
          totalPassers: passers.length,
        };
        writeResults(meta, gPassers);
        log(`Results confirmed: ${passers.length} passers, ${gPassers.length} matching "${cfg.prefix}". Saved ${TXT_FILE} and ${JSON_FILE}.`);
        if (!options.noSend) {
          try {
            const messages = await sendList(meta, gPassers);
            log(`Sent ${messages} Telegram message(s).`);
          } catch (error) {
            log(`Telegram delivery failed: ${error.message}. The list is saved in ${TXT_FILE}.`);
          }
        }
        return;
      }
      pending = { sig, count: passers.length };
      log(`Found ${passers.length} names; confirming stability on the next check.`);
    }

    if (!standBy && passers.length === 0) {
      missingNotices += 1;
      if (missingNotices >= 3 && !formatAlertSent) {
        formatAlertSent = true;
        try {
          const chatId = await resolveChatId();
          await telegram('sendMessage', {
            chat_id: chatId,
            text: `The EELE October 2026 page no longer says "Stand by for results", but I could not parse the passer list. Please check manually: ${cfg.pageUrl}`,
            disable_web_page_preview: true,
          });
          log('Sent a format-change alert to Telegram.');
        } catch (error) {
          log(`Could not send format-change alert: ${error.message}`);
        }
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(cfg.pollMs, remaining));
  }

  log(`Stopped after ${cfg.maxHours} hour(s) without a complete list.`);
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    once: args.includes('--once'),
    cloud: args.includes('--cloud'),
    live: args.includes('--live'),
    heartbeat: args.includes('--heartbeat'),
    noSend: args.includes('--no-send'),
    testMessage: args.includes('--test-message'),
  };
  const cfg = config();
  log(`EELE monitor starting (prefix "${cfg.prefix}", every ${Math.round(cfg.pollMs / 1000)}s, max ${cfg.maxHours}h).`);

  if (options.testMessage) {
    try {
      const me = await telegram('getMe');
      const chatId = await resolveChatId();
      await telegram('sendMessage', {
        chat_id: chatId,
        text: `EELE monitor test OK. Bot @${me.username} will send the October 2026 passers starting with "${cfg.prefix}" here.`,
        disable_web_page_preview: true,
      });
      log(`Test message sent to chat ${chatId}.`);
    } catch (error) {
      log(`Telegram test failed: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (options.live || options.cloud || options.heartbeat) {
    try {
      await ensureTelegramConfig();
      if (options.live) {
        await runLive(cfg);
      } else if (options.heartbeat) {
        await runHeartbeat(cfg);
      } else {
        await runCloud(cfg);
      }
    } catch (error) {
      log(`Cloud check failed: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  await checkTelegramSetup();

  if (options.once) {
    try {
      const found = await runOnce(options, cfg);
      process.exitCode = found > 0 ? 0 : 2;
    } catch (error) {
      log(`Check failed: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    await runMonitor(options, cfg);
  } catch (error) {
    log(`Monitor stopped with an error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parsePassers, buildMessages, chunkText, htmlToLines };

if (require.main === module) {
  main();
}
