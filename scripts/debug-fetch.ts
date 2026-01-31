/**
 * Fetch debugging script
 *
 * Tests various URLs to debug network errors.
 *
 * Usage:
 *   npx tsx scripts/debug-fetch.ts
 */

import { fetchPage, fetchPages } from '../src/web/fetch';

const testUrls = [
  'https://colincooke.ca/',
  'https://github.com/clvcooke',
  'https://horstmeyer.pratt.duke.edu/people/colin-cooke',
  'https://scholar.google.com/citations?user=rbmiR38AAAAJ&hl=en',
  'https://example.com', // control - should always work
];

async function testWithHttp(url: string) {
  console.log(`\n[HTTP] ${url}`);
  const result = await fetchPage(url, { render: false, timeout: 15000 });
  console.log('  Success:', result.success);
  if (result.error) console.log('  Error:', result.error);
  if (result.httpStatus) console.log('  Status:', result.httpStatus);
  if (result.title) console.log('  Title:', result.title?.substring(0, 60));
  if (result.wordCount) console.log('  Words:', result.wordCount);
  if (result.content)
    console.log('  Content:', result.content.substring(0, 500));
  return result;
}

async function testWithBrowser(url: string) {
  console.log(`\n[Browser] ${url}`);
  const result = await fetchPage(url, { render: true, timeout: 15000 });
  console.log('  Success:', result.success);
  if (result.error) console.log('  Error:', result.error);
  if (result.title) console.log('  Title:', result.title?.substring(0, 60));
  return result;
}

async function main() {
  const mode = process.argv[2] || 'http';
  const singleUrl = process.argv[3];

  const urls = singleUrl ? [singleUrl] : testUrls;

  console.log(`Testing ${urls.length} URLs with mode: ${mode}\n`);

  if (mode === 'http') {
    for (const url of urls) {
      await testWithHttp(url);
    }
  } else if (mode === 'browser') {
    for (const url of urls) {
      await testWithBrowser(url);
    }
    // Close browser when done
    const { closeBrowser } = await import('../src/web/browser');
    await closeBrowser();
  } else if (mode === 'both') {
    for (const url of urls) {
      await testWithHttp(url);
      await testWithBrowser(url);
    }
    const { closeBrowser } = await import('../src/web/browser');
    await closeBrowser();
  } else {
    console.log(
      'Usage: npx tsx scripts/debug-fetch.ts [http|browser|both] [url]',
    );
  }
}

main().catch(console.error);
