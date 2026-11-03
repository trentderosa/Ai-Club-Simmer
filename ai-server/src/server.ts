import { createClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { CheckInService } from './services/check-in-service.js';
import { SupabaseCheckInRepository } from './repositories/supabase-check-in-repository.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.error('SUPABASE_URL environment variable is required');
  process.exit(1);
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const checkInRepository = new SupabaseCheckInRepository(supabase);
const checkInService = new CheckInService(checkInRepository);

const app = createApp({ checkInService });

app.listen(PORT, () => {
  console.log(`AI server listening on port ${PORT}`);
});
