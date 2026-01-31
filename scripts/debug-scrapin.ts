/**
 * Scrapin API debugging script
 *
 * Tests the Scrapin.io LinkedIn data enrichment API.
 *
 * Usage:
 *   SCRAPIN_API_KEY="your-key" npx tsx scripts/debug-scrapin.ts [person|company|pipeline]
 */

import { linkedInPipeline } from '../src/web';
import { ScrapinProvider } from '../src/web/scrapin';

const apiKey = process.env.SCRAPIN_API_KEY;
if (!apiKey) {
  console.error('Error: SCRAPIN_API_KEY not set');
  console.error(
    'Usage: SCRAPIN_API_KEY="sk_xxx" npx tsx scripts/debug-scrapin.ts [person|company|pipeline]',
  );
  process.exit(1);
}

async function testPersonRaw() {
  console.log('\n=== Testing Person Fetch (Provider) ===\n');

  const linkedInUrl = 'https://www.linkedin.com/in/michael-sk/';

  console.log(`LinkedIn URL: ${linkedInUrl}`);

  try {
    const provider = new ScrapinProvider(apiKey);
    const result = await provider.fetchPerson(linkedInUrl);
    console.log('\nSuccess:', result.success);
    if (result.person) {
      console.log('Name:', result.person.firstName, result.person.lastName);
      console.log('Headline:', result.person.headline);
      console.log('Positions:', result.person.positions?.positionsCount);
    }
    console.log('\nFull response:');
    console.log(JSON.stringify(result, null, 2).substring(0, 3000));
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testPerson() {
  console.log('\n=== Testing Person Fetch (Provider) ===\n');

  const url = 'https://www.linkedin.com/in/michael-sk/';

  console.log(`Fetching: ${url}`);

  try {
    const provider = new ScrapinProvider(apiKey);
    const result = await provider.fetchPerson(url);
    console.log('\nSuccess:', result.success);
    console.log('Credits left:', result.credits_left);
    if (result.person) {
      console.log('Name:', result.person.firstName, result.person.lastName);
      console.log('Headline:', result.person.headline);
      console.log(
        'Location:',
        result.person.location?.city,
        result.person.location?.country,
      );
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testCompany() {
  console.log('\n=== Testing Company Fetch ===\n');

  const url = 'https://www.linkedin.com/company/google/';

  console.log(`Fetching: ${url}`);

  try {
    const provider = new ScrapinProvider(apiKey);
    const result = await provider.fetchCompany(url);
    console.log('\nSuccess:', result.success);
    if (result.company) {
      console.log('Name:', result.company.name);
      console.log('Industry:', result.company.industry);
      console.log('Employees:', result.company.employeeCount);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

async function testPipeline() {
  console.log('\n=== Testing Pipeline ===\n');

  const pipeline = linkedInPipeline(apiKey);
  const url = 'https://www.linkedin.com/in/michael-sk/';

  console.log(`Fetching via pipeline: ${url}`);

  try {
    const result = await pipeline.fetch(url);
    console.log('\nPipeline Result:');
    console.log('Success:', result.success);
    console.log('Pipeline:', result.pipeline);
    console.log('Title:', result.title);
    console.log('Word Count:', result.wordCount);
    if (result.error) console.log('Error:', result.error);
    if (result.content) {
      console.log('\nContent Preview (first 1500 chars):');
      console.log(result.content.substring(0, 1500));
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

const arg = process.argv[2] || 'raw';

switch (arg) {
  case 'raw':
    testPersonRaw();
    break;
  case 'person':
    testPerson();
    break;
  case 'company':
    testCompany();
    break;
  case 'pipeline':
    testPipeline();
    break;
  case 'all':
    testPersonRaw().then(testPerson).then(testCompany).then(testPipeline);
    break;
  default:
    console.log(
      'Usage: npx tsx scripts/debug-scrapin.ts [raw|person|company|pipeline|all]',
    );
}
