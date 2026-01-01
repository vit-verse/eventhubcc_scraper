import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

/* -------------------- PATH SETUP -------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENTHUB_URL = 'https://eventhubcc.vit.ac.in/EventHub/';
const CACHE_FILE = path.join(__dirname, 'cache', 'last-scrape.json');

/* -------------------- SUPABASE -------------------- */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* -------------------- CACHE -------------------- */

function saveCache(events) {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify(
      {
        scraped_at: new Date().toISOString(),
        total_events: events.length
      },
      null,
      2
    )
  );
}

/* -------------------- HELPERS -------------------- */

function parseEventDate(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function extractTeamSize($card, $) {
  let teamSize = '1';

  $card.find('i').each((_, icon) => {
    const cls = $(icon).attr('class') || '';
    if (
      cls.includes('fa-users') ||
      cls.includes('fa-user') ||
      cls.includes('fa-street-view') ||
      cls.includes('fa-people')
    ) {
      const text = $(icon).parent().text();
      const match = text.match(/\b\d+\s*-\s*\d+\b|\b\d+\b/);
      if (match) {
        teamSize = match[0].replace(/\s+/g, '');
      }
    }
  });

  return teamSize;
}

/* -------------------- SCRAPER -------------------- */

async function scrapeEventHub() {
  console.log('Fetching EventHub...');

  const response = await axios.get(EVENTHUB_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  const $ = cheerio.load(response.data);
  const cards = $('form #events .col-lg-4 .card');

  console.log(`Found ${cards.length} cards`);

  const events = [];
  const seen = new Set();

  cards.each((_, el) => {
    const $card = $(el);

    const eventId = $card.find('button[name="eid"]').attr('value');
    if (!eventId || eventId === '0') return;

    const title = $card.find('.card-title span').first().text().trim();
    if (!title) return;

    const dateStr = $card.find('.fa-calendar-days').next('span').text().trim();
    const venue =
      $card.find('.fa-map-location-dot').next('span').text().trim() || 'TBA';

    let category = 'General';
    $card.find('div').each((_, d) => {
      const txt = $(d).text().trim();
      if (txt.startsWith('(') && txt.endsWith(')')) {
        category = txt.slice(1, -1);
      }
    });

    let participantType = 'All';
    const pIcon = $card.find('.fa-user-check, .fa-people-carry-box');
    if (pIcon.length) {
      const span = pIcon.next('span');
      if (span.length) participantType = span.text().trim();
    }

    const feeText = $card.find('.fa-indian-rupee-sign').next('span').text().trim();
    const entryFee = feeText.toLowerCase() === 'free' ? 0 : parseInt(feeText) || 0;

    const teamSize = extractTeamSize($card, $);

    const uniqueId = `${eventId}_${title}_${category}`;
    if (seen.has(uniqueId)) return;
    seen.add(uniqueId);

    events.push({
      id: uniqueId,
      title,
      event_date: parseEventDate(dateStr),
      venue,
      category,
      participant_type: participantType,
      entry_fee: entryFee,
      team_size: String(teamSize),
      poster_url: `https://eventhubcc.vit.ac.in/EventHub/image/?id=${eventId}`,
      scraped_at: new Date().toISOString(),
      is_active: true
    });
  });

  console.log(`Parsed ${events.length} unique events`);
  return events;
}

/* -------------------- SUPABASE SYNC -------------------- */

async function syncWithSupabase(events) {
  console.log('Clearing old records...');

  const { error: delErr } = await supabase
    .from('official_events')
    .delete()
    .neq('id', '');

  if (delErr) throw delErr;

  console.log('Inserting new records...');

  const { error: insErr } = await supabase
    .from('official_events')
    .insert(events);

  if (insErr) throw insErr;

  saveCache(events);
  console.log('Sync complete');
}

/* -------------------- MAIN -------------------- */

async function main() {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }

    const events = await scrapeEventHub();
    if (!events.length) {
      throw new Error('No events scraped');
    }

    await syncWithSupabase(events);
    console.log('SUCCESS');
    process.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
}

main();
