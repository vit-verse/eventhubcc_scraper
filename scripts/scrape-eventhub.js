import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import https from 'https';
import sharp from 'sharp';

/* ===================== CONSTANTS ===================== */

const EVENTHUB_URL = 'https://eventhubcc.vit.ac.in/EventHub/';
const POSTER_BASE = 'https://eventhubcc.vit.ac.in/EventHub/image/?id=';

const BUCKET = 'eventhub-posters';
const BASE_FOLDER = 'eventhub';

const MAX_IMAGE_SIZE = 1024 * 1024; // 1 MB strict

/* ===================== SUPABASE ===================== */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ===================== HELPERS ===================== */

const slugify = (str) =>
  str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

function parseEventDate(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Only allow today or future events
 */
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

  $card.find('i').each((_, icon) => {
    const cls = $(icon).attr('class') || '';
    if (cls.includes('fa-user')) {
      const text = $(icon).parent().text();
      const match = text.match(/\b\d+\s*-\s*\d+\b|\b\d+\b/);
      if (match) teamSize = match[0].replace(/\s+/g, '');
    }
  });

  return teamSize;
}

/* ===================== IMAGE COMPRESSION ===================== */

async function compressImageStrict(buffer) {
  let quality = 80;

  while (quality >= 30) {
    const output = await sharp(buffer)
      .resize({ width: 1024, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();

    if (output.length < MAX_IMAGE_SIZE) {
      return output;
    }

    quality -= 10;
  }

  throw new Error('Poster cannot be compressed below 1MB');
}

/* ===================== POSTER UPLOAD ===================== */

async function uploadPoster(eventhubId, variantKey) {
  const srcUrl = `${POSTER_BASE}${eventhubId}`;

  const res = await axios.get(srcUrl, {
    responseType: 'arraybuffer',
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  const compressed = await compressImageStrict(res.data);

  const filePath = `${BASE_FOLDER}/${eventhubId}/${variantKey}.webp`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filePath, compressed, {
      contentType: 'image/webp',
      upsert: true
    });

  if (error) throw error;

  const { data } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(filePath);

  return data.publicUrl;
}

/* ===================== STORAGE CLEANUP ===================== */

async function clearEventHubPosters() {
  const { data: folders, error } = await supabase.storage
    .from(BUCKET)
    .list(BASE_FOLDER);

  if (error || !folders?.length) return;

  const paths = [];

  for (const folder of folders) {
    const { data: files } = await supabase.storage
      .from(BUCKET)
      .list(`${BASE_FOLDER}/${folder.name}`);

    files?.forEach(f =>
      paths.push(`${BASE_FOLDER}/${folder.name}/${f.name}`)
    );
  }

  if (paths.length) {
    await supabase.storage.from(BUCKET).remove(paths);
  }
}

/* ===================== SCRAPER ===================== */

async function scrapeEventHub() {
  const response = await axios.get(EVENTHUB_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  const $ = cheerio.load(response.data);
  const cards = $('form #events .col-lg-4 .card');

  const events = [];

  for (const el of cards) {
    const $card = $(el);

    const eventhubId = $card.find('button[name="eid"]').attr('value');
    if (!eventhubId || eventhubId === '0') continue;

    const title = $card.find('.card-title span').first().text().trim();
    if (!title) continue;

    const dateStr = $card.find('.fa-calendar-days').next('span').text().trim();

    // HARD FILTER: skip past events completely
    if (!isUpcomingOrOngoing(dateStr)) continue;

    const venue =
      $card.find('.fa-map-location-dot').next('span').text().trim() || 'TBA';

    let category = 'General';
    $card.find('div').each((_, d) => {
      const t = $(d).text().trim();
      if (t.startsWith('(') && t.endsWith(')')) category = t.slice(1, -1);
    });

    let participantType = 'All';
    const p = $card.find('.fa-user-check, .fa-people-carry-box').next('span');
    if (p.length) participantType = p.text().trim();

    const feeText = $card.find('.fa-indian-rupee-sign').next('span').text().trim();
    const entryFee =
      feeText.toLowerCase() === 'free' ? 0 : parseInt(feeText) || 0;

    const teamSize = extractTeamSize($card, $);

    const variantKey = slugify(`${category}|${participantType}|${entryFee}`);
    const eventId = `official:${eventhubId}:${variantKey}`;

    // Poster upload ONLY after date filter
    const poster_url = await uploadPoster(eventhubId, variantKey);

    events.push({
      id: eventId,
      title,
      event_date: parseEventDate(dateStr),
      venue,
      category,
      participant_type: participantType,
      entry_fee: entryFee,
      team_size: teamSize,
      poster_url,
      is_active: true
    });
  }

  return events;
}

/* ===================== SYNC ===================== */

async function sync(events) {
  await clearEventHubPosters();

  await supabase
    .from('official_events')
    .delete()
    .neq('id', '');

  const { error } = await supabase
    .from('official_events')
    .insert(events);

  if (error) throw error;
}

/* ===================== MAIN ===================== */

(async () => {
  try {
    const events = await scrapeEventHub();
    if (!events.length) {
      console.log('No upcoming events found');
      return;
    }

    await sync(events);
    console.log('SUCCESS');
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
})();
