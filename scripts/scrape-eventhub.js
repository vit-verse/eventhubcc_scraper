import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// CONFIGURATION
// ============================================
const EVENTHUB_URL = 'https://eventhubcc.vit.ac.in/EventHub/';
const CACHE_FILE = path.join(__dirname, 'cache', 'last-scrape.json');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ============================================
// HELPER FUNCTIONS
// ============================================

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('❌ Error loading cache:', error.message);
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
    console.log('✅ Cache saved successfully');
  } catch (error) {
    console.error('❌ Error saving cache:', error.message);
  }
}

function parseEventDate(dateStr) {
  try {
    // EventHub format: "2025-01-15" or similar
    return new Date(dateStr).toISOString();
  } catch (error) {
    console.error('❌ Error parsing date:', dateStr);
    return new Date().toISOString();
  }
}

function parseTeamSize(teamSizeText) {
  if (!teamSizeText) return '1';
  
  // Extract numbers from text like "2-4" or "Individual"
  const match = teamSizeText.match(/(\d+)(?:-(\d+))?/);
  if (match) {
    return match[2] ? `${match[1]}-${match[2]}` : match[1];
  }
  
  return teamSizeText.toLowerCase().includes('individual') ? '1' : teamSizeText;
}

// ============================================
// SCRAPING FUNCTION
// ============================================

async function scrapeEventHub() {
  console.log('🚀 Starting EventHub scraper...');
  console.log(`📅 Timestamp: ${new Date().toISOString()}`);
  
  try {
    // Fetch HTML
    console.log('📡 Fetching EventHub page...');
    const response = await axios.get(EVENTHUB_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000,
      httpsAgent: new (await import('https')).Agent({
        rejectUnauthorized: false // Handle self-signed cert
      })
    });
    
    console.log(`✅ Fetched HTML (${response.data.length} bytes)`);
    
    // Parse HTML
    const $ = cheerio.load(response.data);
    const eventCards = $('form #events .col-lg-4 .card');
    
    console.log(`📋 Found ${eventCards.length} event cards`);
    
    if (eventCards.length === 0) {
      throw new Error('No event cards found - HTML structure may have changed');
    }
    
    // Parse events
    const scrapedEvents = [];
    
    eventCards.each((index, element) => {
      try {
        const $card = $(element);
        
        // Extract event ID
        const eventId = $card.find('button[name="eid"]').val();
        if (!eventId || eventId === '0') {
          console.warn(`⚠️  Skipping card ${index + 1}: No valid event ID`);
          return;
        }
        
        // Extract title
        const title = $card.find('.card-title span').text().trim();
        if (!title) {
          console.warn(`⚠️  Skipping event ${eventId}: No title`);
          return;
        }
        
        // Extract date
        const dateSpan = $card.find('.fa-calendar-days').next('span');
        const dateStr = dateSpan.text().trim();
        
        // Extract venue
        const venueSpan = $card.find('.fa-map-location-dot').next('span');
        const venue = venueSpan.text().trim() || 'TBA';
        
        // Extract category (from text in parentheses)
        let category = 'General';
        $card.find('div').each((i, div) => {
          const text = $(div).text().trim();
          const match = text.match(/\(([^)]+)\)/);
          if (match) {
            category = match[1];
            return false; // break
          }
        });
        
        // Extract participant type
        const participantIcon = $card.find('.fa-user-check, .fa-people-carry-box');
        let participantType = 'All';
        if (participantIcon.length > 0) {
          const participantSpan = participantIcon.parent().find('span');
          if (participantSpan.length > 0) {
            participantType = participantSpan.text().trim();
          }
        }
        
        // Extract fee
        const feeSpan = $card.find('.fa-indian-rupee-sign').next('span');
        const feeStr = feeSpan.text().trim();
        const entryFee = parseInt(feeStr) || 0;
        
        // Extract team size
        const teamIcon = $card.find('.fa-street-view, .fa-users');
        let teamSize = '1';
        if (teamIcon.length > 0) {
          const teamSpans = teamIcon.parent().find('span');
          if (teamSpans.length > 1) {
            const min = $(teamSpans[0]).text().trim();
            const max = $(teamSpans[1]).text().trim();
            teamSize = `${min}-${max}`;
          } else if (teamSpans.length === 1) {
            teamSize = parseTeamSize($(teamSpans[0]).text().trim());
          }
        }
        
        // Check for poster image (if available)
        const posterImg = $card.find('img').first();
        const posterUrl = posterImg.length > 0 ? posterImg.attr('src') : null;
        
        const event = {
          id: eventId,
          title: title,
          event_date: parseEventDate(dateStr),
          venue: venue,
          category: category,
          participant_type: participantType,
          entry_fee: entryFee,
          team_size: teamSize,
          poster_url: posterUrl,
          scraped_at: new Date().toISOString()
        };
        
        scrapedEvents.push(event);
        console.log(`✅ Parsed event ${index + 1}/${eventCards.length}: ${title}`);
        
      } catch (error) {
        console.error(`❌ Error parsing card ${index + 1}:`, error.message);
      }
    });
    
    console.log(`\n📊 Successfully parsed ${scrapedEvents.length} events`);
    return scrapedEvents;
    
  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
    throw error;
  }
}

// ============================================
// SYNC WITH SUPABASE
// ============================================

async function syncWithSupabase(scrapedEvents) {
  console.log('\n🔄 Syncing with Supabase...');
  
  try {
    // Load cache
    const cache = loadCache();
    const cachedEvents = cache.events || [];
    
    // Create maps for comparison
    const cachedMap = new Map(cachedEvents.map(e => [e.id, e]));
    const scrapedMap = new Map(scrapedEvents.map(e => [e.id, e]));
    
    // Find changes
    const newEvents = [];
    const updatedEvents = [];
    const unchangedEvents = [];
    
    for (const event of scrapedEvents) {
      const cached = cachedMap.get(event.id);
      
      if (!cached) {
        newEvents.push(event);
      } else {
        // Check if event data changed
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
    
    // Find deleted events
    const deletedEventIds = [];
    for (const cached of cachedEvents) {
      if (!scrapedMap.has(cached.id)) {
        deletedEventIds.push(cached.id);
      }
    }
    
    console.log(`\n📈 Changes detected:`);
    console.log(`  🆕 New events: ${newEvents.length}`);
    console.log(`  🔄 Updated events: ${updatedEvents.length}`);
    console.log(`  🗑️  Deleted events: ${deletedEventIds.length}`);
    console.log(`  ✅ Unchanged events: ${unchangedEvents.length}`);
    
    // Apply changes to Supabase
    let totalChanges = 0;
    
    // 1. Insert/Update events (upsert)
    if (newEvents.length > 0 || updatedEvents.length > 0) {
      const eventsToUpsert = [...newEvents, ...updatedEvents];
      
      console.log(`\n📤 Upserting ${eventsToUpsert.length} events...`);
      const { error } = await supabase
        .from('official_events')
        .upsert(eventsToUpsert, { onConflict: 'id' });
      
      if (error) {
        throw new Error(`Upsert failed: ${error.message}`);
      }
      
      console.log(`✅ Upserted ${eventsToUpsert.length} events`);
      totalChanges += eventsToUpsert.length;
    }
    
    // 2. Mark deleted events as inactive
    if (deletedEventIds.length > 0) {
      console.log(`\n🗑️  Marking ${deletedEventIds.length} events as inactive...`);
      
      const { error } = await supabase
        .from('official_events')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .in('id', deletedEventIds);
      
      if (error) {
        throw new Error(`Delete failed: ${error.message}`);
      }
      
      console.log(`✅ Marked ${deletedEventIds.length} events as inactive`);
      totalChanges += deletedEventIds.length;
    }
    
    // Save cache
    saveCache(scrapedEvents);
    
    console.log(`\n✅ Sync completed! Total changes: ${totalChanges}`);
    
    return {
      success: true,
      totalEvents: scrapedEvents.length,
      newEvents: newEvents.length,
      updatedEvents: updatedEvents.length,
      deletedEvents: deletedEventIds.length,
      unchangedEvents: unchangedEvents.length
    };
    
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    throw error;
  }
}

// ============================================
// MAIN EXECUTION
// ============================================

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('   EVENTHUB SCRAPER - GitHub Actions   ');
  console.log('═══════════════════════════════════════\n');
  
  try {
    // Validate environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Missing Supabase credentials in environment variables');
    }
    
    // Step 1: Scrape EventHub
    const scrapedEvents = await scrapeEventHub();
    
    if (scrapedEvents.length === 0) {
      throw new Error('No events scraped - aborting sync');
    }
    
    // Step 2: Sync with Supabase
    const result = await syncWithSupabase(scrapedEvents);
    
    // Step 3: Summary
    console.log('\n═══════════════════════════════════════');
    console.log('           SCRAPE SUMMARY              ');
    console.log('═══════════════════════════════════════');
    console.log(`✅ Status: SUCCESS`);
    console.log(`📊 Total Events: ${result.totalEvents}`);
    console.log(`🆕 New: ${result.newEvents}`);
    console.log(`🔄 Updated: ${result.updatedEvents}`);
    console.log(`🗑️  Deleted: ${result.deletedEvents}`);
    console.log(`✅ Unchanged: ${result.unchangedEvents}`);
    console.log(`⏰ Completed at: ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════\n');
    
    process.exit(0);
    
  } catch (error) {
    console.error('\n═══════════════════════════════════════');
    console.error('           SCRAPE FAILED               ');
    console.error('═══════════════════════════════════════');
    console.error(`❌ Error: ${error.message}`);
    console.error(`⏰ Failed at: ${new Date().toISOString()}`);
    console.error('═══════════════════════════════════════\n');
    
    process.exit(1);
  }
}

// Run the scraper
main();