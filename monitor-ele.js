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
    pollMs: Math.max(60, num(e.POLL_SECONDS, 120)) * 1000,
    heartbeatMs: Math.max(60, num(e.HEARTBEAT_SECONDS, 600)) * 1000,
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

async function fetchPage(pageUrl) {
  const url = new URL(pageUrl);
  url.searchParams.set('_prcb', String(Date.now()));
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (/cf-browser-verification|challenge-platform|<title>\s*Just a moment/i.test(text)) {
    throw new Error('blocked by an anti-bot challenge');
  }
  return text;
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

function buildMessages(meta, gPassers, pageUrl) {
  const header = [
    `EELE October 2026 passers with surname starting with "${meta.prefix}"`,
    `${gPassers.length} found out of ${meta.totalPassers} passers listed.`,
    pageUrl,
  ].join('\n');
  const rows = gPassers.map((p) => `${p.seq}. ${p.surname}, ${p.given}`);
  const chunks = rows.length ? chunkText(rows) : [''];
  return chunks.map((chunk, index) => {
    const prefix = chunks.length > 1 ? `Part ${index + 1}/${chunks.length}\n` : '';
    return `${index === 0 ? `${header}\n\n` : ''}${prefix}${chunk}`.trimEnd();
  });
}

async function sendList(meta, gPassers, pageUrl) {
  const chatId = await resolveChatId();
  const messages = buildMessages(meta, gPassers, pageUrl);
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
  const html = await fetchPage(cfg.pageUrl);
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
      const messages = await sendList(meta, gPassers, cfg.pageUrl);
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

function minutesLabel(ms) {
  const minutes = ms / 60000;
  return Number.isInteger(minutes) ? `${minutes}` : minutes.toFixed(1);
}

async function runHeartbeat(cfg) {
  if (readSentState(cfg).state) {
    log('Already delivered; heartbeat skipped.');
    return;
  }

  let status;
  try {
    const html = await fetchPage(cfg.pageUrl);
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
    `Site checks: every ${minutesLabel(cfg.pollMs)} minutes. Updates: every ${minutesLabel(cfg.heartbeatMs)} minutes.`,
    status,
    runUrl ? `Run details: ${runUrl}` : '',
  ].filter(Boolean).join('\n');

  const chatId = await resolveChatId();
  await telegram('sendMessage', { chat_id: chatId, text: message, disable_web_page_preview: true });
  log(`Heartbeat sent: ${status}`);
}

async function sendLiveHeartbeat(cfg, status, checkedAt, first) {
  if (readSentState(cfg).state) return true;

  const runUrl = (getEnv().GITHUB_RUN_URL || '').trim();
  const message = [
    first ? 'EELE live monitor started on GitHub Actions.' : 'EELE monitor heartbeat',
    first
      ? `This is the first check-in. The list will be sent here automatically once the complete roster appears; updates follow every ${minutesLabel(cfg.heartbeatMs)} minutes.`
      : `The monitor is still running; the list will be sent automatically when it is complete.`,
    `Checked: ${checkedAt ? manilaTime(checkedAt) : 'starting now'} (Asia/Manila)`,
    `Checks: every ${minutesLabel(cfg.pollMs)} minutes. Updates: every ${minutesLabel(cfg.heartbeatMs)} minutes.`,
    `Status: ${status}`,
    runUrl ? `Run details: ${runUrl}` : '',
  ].filter(Boolean).join('\n');

  try {
    const chatId = await resolveChatId();
    await telegram('sendMessage', { chat_id: chatId, text: message, disable_web_page_preview: true });
    log(`Heartbeat sent: ${status}`);
    return true;
  } catch (error) {
    log(`Heartbeat failed: ${error.message}`);
    return false;
  }
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
      const messages = await sendList(meta, gPassers, cfg.pageUrl);
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
  const html = await fetchPage(cfg.pageUrl);
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

async function runLive(cfg) {
  const { state } = readSentState(cfg);
  if (state) {
    log(`Already delivered at ${state.deliveredAt || 'an earlier run'}; live monitor exiting.`);
    return;
  }

  const deadline = Date.now() + cfg.maxHours * 3600 * 1000;
  let lastStatus = 'The first page check has not finished yet.';
  let lastCheckedAt = null;
  let firstHeartbeat = true;
  let nextHeartbeat = Date.now();
  let nextPoll = Date.now();

  while (Date.now() < deadline) {
    if (Date.now() >= nextPoll) {
      nextPoll = Date.now() + cfg.pollMs;
      try {
        const html = await fetchPage(cfg.pageUrl);
        const { passers, complete } = parsePassers(html);
        lastCheckedAt = new Date();
        if (complete) {
          const delivered = await deliverList(cfg, passers, cfg.stateFile);
          if (delivered) return;
          lastStatus = `The full list is live (${passers.length} passers) but Telegram delivery failed; retrying on the next check.`;
        } else {
          lastStatus = pageStatus(passers, complete, cfg.prefix);
        }
        log(lastStatus);
      } catch (error) {
        lastStatus = `Could not check the page: ${error.message}`;
        log(`${lastStatus}. Retrying in ${Math.round(cfg.pollMs / 1000)}s.`);
      }
    }

    if (Date.now() >= nextHeartbeat) {
      const sent = await sendLiveHeartbeat(cfg, lastStatus, lastCheckedAt, firstHeartbeat);
      firstHeartbeat = false;
      nextHeartbeat = Date.now() + (sent ? cfg.heartbeatMs : 60000);
    }

    if (readSentState(cfg).state) {
      log('Another run marked the list as delivered; live monitor exiting.');
      return;
    }

    const now = Date.now();
    const remaining = deadline - now;
    if (remaining <= 0) break;
    const nextDue = Math.min(nextPoll, nextHeartbeat);
    await sleep(Math.max(500, Math.min(nextDue - now, remaining)));
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
      html = await fetchPage(cfg.pageUrl);
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
            const messages = await sendList(meta, gPassers, cfg.pageUrl);
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
