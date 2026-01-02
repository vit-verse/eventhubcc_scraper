import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import sharp from 'sharp';

/* ================= CONFIG ================= */

const EVENTHUB_URL = 'https://eventhubcc.vit.ac.in/EventHub/';
const POSTER_SRC = 'https://eventhubcc.vit.ac.in/EventHub/image/?id=';

const BUCKET = 'events';
const BASE_FOLDER = 'eventhub';
const MAX_IMAGE_SIZE = 1024 * 1024; // 1 MB strict
const PARALLEL_UPLOADS = 4;

/* ================= SUPABASE ================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ================= HELPERS ================= */

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function parseEventDate(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function isUpcomingOrOngoing(dateStr) {
  const eventDate = new Date(dateStr);
  if (isNaN(eventDate.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  eventDate.setHours(0, 0, 0, 0);

  return eventDate >= today;
}

function extractTeamSize($card, $) {
  let teamSize = '1';
  $card.find('i').each((_, i) => {
    if (($(i).attr('class') || '').includes('fa-user')) {
      const m = $(i).parent().text().match(/\b\d+\s*-\s*\d+|\b\d+\b/);
      if (m) teamSize = m[0].replace(/\s+/g, '');
    }
  });
  return teamSize;
}

/* ================= IMAGE ================= */

async function compressImage(buffer) {
  let quality = 80;
  while (quality >= 30) {
    const out = await sharp(buffer)
      .resize({ width: 1024, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    if (out.length < MAX_IMAGE_SIZE) return out;
    quality -= 10;
  }
  throw new Error('Unable to compress image below 1MB');
}

async function uploadPoster(eventhubId, variantKey) {
  const res = await axios.get(`${POSTER_SRC}${eventhubId}`, {
    responseType: 'arraybuffer',
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  const compressed = await compressImage(res.data);
  const path = `${BASE_FOLDER}/${eventhubId}/${variantKey}.webp`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, compressed, {
      upsert: true,
      contentType: 'image/webp'
    });

  if (error) throw error;

  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/* ================= STORAGE CLEANUP ================= */

async function clearEventHubPosters() {
  const { data: folders } = await supabase.storage
    .from(BUCKET)
    .list(BASE_FOLDER);

  if (!folders?.length) return;

  const paths = [];
  for (const f of folders) {
    const { data: files } = await supabase.storage
      .from(BUCKET)
      .list(`${BASE_FOLDER}/${f.name}`);
    files?.forEach(x => paths.push(`${BASE_FOLDER}/${f.name}/${x.name}`));
  }

  if (paths.length) {
    await supabase.storage.from(BUCKET).remove(paths);
  }
}

/* ================= PARALLEL UTILITY ================= */

async function parallelLimit(items, limit, fn) {
  const results = [];
  const running = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    running.push(p);
    if (running.length >= limit) {
      await Promise.race(running);
      running.splice(0, running.length - limit + 1);
    }
  }
  return Promise.all(results);
}

/* ================= SCRAPER ================= */

async function scrapeEventHub() {
  const html = await axios.get(EVENTHUB_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  const $ = cheerio.load(html.data);
  const cards = $('form #events .col-lg-4 .card');

  const tasks = [];
  const events = [];

  cards.each((_, el) => {
    const $c = $(el);
    const eid = $c.find('button[name="eid"]').attr('value');
    if (!eid || eid === '0') return;

    const title = $c.find('.card-title span').first().text().trim();
    if (!title) return;

    const dateStr = $c.find('.fa-calendar-days').next('span').text().trim();
    if (!isUpcomingOrOngoing(dateStr)) return;

    const venue = $c.find('.fa-map-location-dot').next('span').text().trim() || 'TBA';

    let category = 'General';
    $c.find('div').each((_, d) => {
      const t = $(d).text().trim();
      if (t.startsWith('(') && t.endsWith(')')) category = t.slice(1, -1);
    });

    let participant = 'All';
    const p = $c.find('.fa-user-check, .fa-people-carry-box').next('span');
    if (p.length) participant = p.text().trim();

    const feeText = $c.find('.fa-indian-rupee-sign').next('span').text().trim();
    const fee = feeText.toLowerCase() === 'free' ? 0 : parseInt(feeText) || 0;

    const teamSize = extractTeamSize($c, $);
    const variantKey = slugify(`${category}|${participant}|${fee}`);
    const eventId = `official:${eid}:${variantKey}`;

    tasks.push(async () => {
      const poster_url = await uploadPoster(eid, variantKey);
      events.push({
        id: eventId,
        title,
        event_date: parseEventDate(dateStr),
        venue,
        category,
        participant_type: participant,
        entry_fee: fee,
        team_size: teamSize,
        poster_url,
        is_active: true
      });
    });
  });

  await parallelLimit(tasks, PARALLEL_UPLOADS, t => t());
  return events;
}

/* ================= MAIN FLOW ================= */

async function run() {
  await clearEventHubPosters();

  await supabase
    .from('official_events')
    .delete()
    .neq('id', '');

  const events = await scrapeEventHub();
  if (!events.length) return;

  const { error } = await supabase
    .from('official_events')
    .insert(events);

  if (error) throw error;
}

run()
  .then(() => console.log('SUCCESS'))
  .catch(e => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
