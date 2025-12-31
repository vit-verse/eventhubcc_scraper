import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENTHUB_URL = 'https://eventhubcc.vit.ac.in/EventHub/';
const CACHE_FILE = path.join(__dirname, 'cache', 'last-scrape.json');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading cache:', error.message);
  }
  return { events: [], lastScrape: null };
}

function saveCache(events) {
  try {
    const cacheDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    const cacheData = {
      events: events,
      lastScrape: new Date().toISOString(),
      totalEvents: events.length
    };
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
    console.log('Cache saved successfully');
  } catch (error) {
    console.error('Error saving cache:', error.message);
  }
}

function parseEventDate(dateStr) {
  try {
    return new Date(dateStr).toISOString();
  } catch (error) {
    console.error('Error parsing date:', dateStr);
    return new Date().toISOString();
  }
}

async function scrapeEventHub() {
  console.log('Starting EventHub scraper...');
  console.log('Timestamp:', new Date().toISOString());
  
  try {
    console.log('Fetching EventHub page...');
    const response = await axios.get(EVENTHUB_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000,
      httpsAgent: new (await import('https')).Agent({
        rejectUnauthorized: false
      })
    });
    
    console.log(`Fetched HTML (${response.data.length} bytes)`);
    
    const $ = cheerio.load(response.data);
    const eventCards = $('form #events .col-lg-4 .card');
    
    console.log(`Found ${eventCards.length} event cards`);
    
    if (eventCards.length === 0) {
      throw new Error('No event cards found');
    }
    
    const scrapedEvents = [];
    const eventMap = new Map();
    
    eventCards.each((index, element) => {
      try {
        const $card = $(element);
        
        const eventId = $card.find('button[name="eid"]').attr('value');
        if (!eventId || eventId === '0') {
          return;
        }
        
        const title = $card.find('.card-title span').first().text().trim();
        if (!title) {
          return;
        }
        
        const dateSpan = $card.find('.fa-calendar-days').next('span');
        const dateStr = dateSpan.text().trim();
        
        const venueSpan = $card.find('.fa-map-location-dot').next('span');
        const venue = venueSpan.text().trim() || 'TBA';
        
        let category = 'General';
        const categoryDiv = $card.find('div').filter((i, el) => {
          const text = $(el).text().trim();
          return text.startsWith('(') && text.endsWith(')');
        }).first();
        if (categoryDiv.length > 0) {
          const categoryText = categoryDiv.find('span').text().trim();
          if (categoryText) {
            category = categoryText;
          }
        }
        
        const participantIcon = $card.find('.fa-user-check, .fa-people-carry-box');
        let participantType = 'All';
        if (participantIcon.length > 0) {
          const participantSpan = participantIcon.next('span');
          if (participantSpan.length > 0) {
            participantType = participantSpan.text().trim();
          }
        }
        
        const feeSpan = $card.find('.fa-indian-rupee-sign').next('span');
        const feeStr = feeSpan.text().trim();
        const entryFee = parseInt(feeStr) || 0;
        
        const teamIcon = $card.find('.fa-street-view, .fa-users');
        let teamSize = '1';
        if (teamIcon.length > 0) {
          const teamSpan = teamIcon.next('span');
          if (teamSpan.length > 0) {
            teamSize = teamSpan.text().trim();
          }
        }
        
        const uniqueKey = `${eventId}_${title}_${category}`;
        
        if (!eventMap.has(uniqueKey)) {
          const event = {
            id: uniqueKey,
            title: title,
            event_date: parseEventDate(dateStr),
            venue: venue,
            category: category,
            participant_type: participantType,
            entry_fee: entryFee,
            team_size: teamSize,
            poster_url: null,
            scraped_at: new Date().toISOString()
          };
          
          eventMap.set(uniqueKey, event);
          scrapedEvents.push(event);
        }
        
      } catch (error) {
        console.error(`Error parsing card ${index + 1}:`, error.message);
      }
    });
    
    console.log(`Successfully parsed ${scrapedEvents.length} unique events`);
    return scrapedEvents;
    
  } catch (error) {
    console.error('Scraping failed:', error.message);
    throw error;
  }
}
async function syncWithSupabase(scrapedEvents) {
  console.log('Syncing with Supabase...');
  
  try {
    const cache = loadCache();
    const cachedEvents = cache.events || [];
    
    const cachedMap = new Map(cachedEvents.map(e => [e.id, e]));
    const scrapedMap = new Map(scrapedEvents.map(e => [e.id, e]));
    
    const newEvents = [];
    const updatedEvents = [];
    const unchangedEvents = [];
    
    for (const event of scrapedEvents) {
      const cached = cachedMap.get(event.id);
      
      if (!cached) {
        newEvents.push(event);
      } else {
        const hasChanged = 
          cached.title !== event.title ||
          cached.event_date !== event.event_date ||
          cached.venue !== event.venue ||
          cached.category !== event.category ||
          cached.entry_fee !== event.entry_fee ||
          cached.team_size !== event.team_size;
        
        if (hasChanged) {
          updatedEvents.push(event);
        } else {
          unchangedEvents.push(event);
        }
      }
    }
    
    const deletedEventIds = [];
    for (const cached of cachedEvents) {
      if (!scrapedMap.has(cached.id)) {
        deletedEventIds.push(cached.id);
      }
    }
    
    console.log('Changes detected:');
    console.log(`  New events: ${newEvents.length}`);
    console.log(`  Updated events: ${updatedEvents.length}`);
    console.log(`  Deleted events: ${deletedEventIds.length}`);
    console.log(`  Unchanged events: ${unchangedEvents.length}`);
    
    let totalChanges = 0;
    
    if (newEvents.length > 0 || updatedEvents.length > 0) {
      const eventsToUpsert = [...newEvents, ...updatedEvents];
      
      console.log(`Upserting ${eventsToUpsert.length} events...`);
      const { error } = await supabase
        .from('official_events')
        .upsert(eventsToUpsert, { onConflict: 'id' });
      
      if (error) {
        throw new Error(`Upsert failed: ${error.message}`);
      }
      
      console.log(`Upserted ${eventsToUpsert.length} events`);
      totalChanges += eventsToUpsert.length;
    }
    
    if (deletedEventIds.length > 0) {
      console.log(`Marking ${deletedEventIds.length} events as inactive...`);
      
      const { error } = await supabase
        .from('official_events')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .in('id', deletedEventIds);
      
      if (error) {
        throw new Error(`Delete failed: ${error.message}`);
      }
      
      console.log(`Marked ${deletedEventIds.length} events as inactive`);
      totalChanges += deletedEventIds.length;
    }
    
    saveCache(scrapedEvents);
    
    console.log(`Sync completed! Total changes: ${totalChanges}`);
    
    return {
      success: true,
      totalEvents: scrapedEvents.length,
      newEvents: newEvents.length,
      updatedEvents: updatedEvents.length,
      deletedEvents: deletedEventIds.length,
      unchangedEvents: unchangedEvents.length
    };
    
  } catch (error) {
    console.error('Sync failed:', error.message);
    throw error;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('EVENTHUB SCRAPER - GitHub Actions');
  console.log('='.repeat(50));
  
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Missing Supabase credentials');
    }
    
    const scrapedEvents = await scrapeEventHub();
    
    if (scrapedEvents.length === 0) {
      throw new Error('No events scraped - aborting sync');
    }
    
    const result = await syncWithSupabase(scrapedEvents);
    
    console.log('='.repeat(50));
    console.log('SCRAPE SUMMARY');
    console.log('='.repeat(50));
    console.log(`Status: SUCCESS`);
    console.log(`Total Events: ${result.totalEvents}`);
    console.log(`New: ${result.newEvents}`);
    console.log(`Updated: ${result.updatedEvents}`);
    console.log(`Deleted: ${result.deletedEvents}`);
    console.log(`Unchanged: ${result.unchangedEvents}`);
    console.log(`Completed at: ${new Date().toISOString()}`);
    console.log('='.repeat(50));
    
    process.exit(0);
    
  } catch (error) {
    console.error('='.repeat(50));
    console.error('SCRAPE FAILED');
    console.error('='.repeat(50));
    console.error(`Error: ${error.message}`);
    console.error(`Failed at: ${new Date().toISOString()}`);
    console.error('='.repeat(50));
    
    process.exit(1);
  }
}

main();