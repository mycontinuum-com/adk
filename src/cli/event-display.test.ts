import {
  extractCurrentThoughtBlock,
  truncate,
  getEventDetail,
  getEventSummary,
} from './event-display';
import type { StreamingMetadata } from './blocks';
import type { ThoughtEvent, AssistantEvent } from '../types';

describe('extractCurrentThoughtBlock', () => {
  it('returns original text when no thought block headers are present', () => {
    const text = 'Just some plain text without any headers';
    expect(extractCurrentThoughtBlock(text)).toBe(text);
  });

  it('returns text from the last thought block header', () => {
    const text =
      '**First Block**\n\nContent of first block.**Second Block**\n\nContent of second block.';
    expect(extractCurrentThoughtBlock(text)).toBe(
      '**Second Block**\n\nContent of second block.',
    );
  });

  it('extracts text starting from the most recent header when multiple exist', () => {
    const text = `**Ensuring Accurate References**

I need to be careful not to present hypothetical sources as real ones.**Crafting JSON and Headlines**

I need to ensure that the JSON structure matches.**Defining Section Key Points**

For the second section, titled "Improve Code Quality"`;

    expect(extractCurrentThoughtBlock(text)).toBe(
      `**Defining Section Key Points**

For the second section, titled "Improve Code Quality"`,
    );
  });

  it('handles incomplete headers at the end of text', () => {
    const text = 'Some previous content.**Starting New Block';
    expect(extractCurrentThoughtBlock(text)).toBe('**Starting New Block');
  });

  it('handles incomplete headers with capital letter', () => {
    const text = 'Previous block content here.**Analyzing The';
    expect(extractCurrentThoughtBlock(text)).toBe('**Analyzing The');
  });

  it('ignores lowercase bold patterns that are not thought headers', () => {
    const text = '**Title Block**\n\nThis has **bold text** inside it.';
    expect(extractCurrentThoughtBlock(text)).toBe(text);
  });

  it('handles single block correctly', () => {
    const text = '**Only Block**\n\nThis is the only content.';
    expect(extractCurrentThoughtBlock(text)).toBe(text);
  });

  it('returns empty string unchanged', () => {
    expect(extractCurrentThoughtBlock('')).toBe('');
  });

  it('handles text with only incomplete header', () => {
    const text = '**Starting';
    expect(extractCurrentThoughtBlock(text)).toBe('**Starting');
  });

  it('handles header at the very start followed by new header', () => {
    const text = '**First** content **Second** more content';
    expect(extractCurrentThoughtBlock(text)).toBe('**Second** more content');
  });
});

describe('truncate', () => {
  it('collapses whitespace into single spaces', () => {
    const text = 'Hello\n\nWorld\t\tTest';
    expect(truncate(text)).toBe('Hello World Test');
  });

  it('truncates to maxLength with ellipsis', () => {
    const text = 'This is a very long string that should be truncated';
    expect(truncate(text, 20)).toBe('This is a very lo...');
  });

  it('returns full text when under maxLength', () => {
    const text = 'Short text';
    expect(truncate(text, 20)).toBe('Short text');
  });

  it('handles undefined maxLength by returning full text', () => {
    const text = 'Any length of text should be returned in full';
    expect(truncate(text)).toBe(text);
  });
});

describe('getEventDetail', () => {
  const createThoughtEvent = (text: string): ThoughtEvent => ({
    id: 'thought-1',
    type: 'thought',
    createdAt: Date.now(),
    invocationId: 'inv-1',
    agentName: 'test_agent',
    text,
  });

  const createAssistantEvent = (text: string): AssistantEvent => ({
    id: 'assistant-1',
    type: 'assistant',
    createdAt: Date.now(),
    invocationId: 'inv-1',
    agentName: 'test_agent',
    text,
  });

  it('shows streaming header when streaming metadata is provided for thought', () => {
    const event = createThoughtEvent('Some thought content');
    const streaming: StreamingMetadata = {
      chunkCount: 5,
      deltaEvents: [],
    };
    const result = getEventDetail(event, 'clean', streaming);
    expect(result).toBe('[Streamed in 5 chunks]\n\nSome thought content');
  });

  it('shows streaming header when streaming metadata is provided for assistant', () => {
    const event = createAssistantEvent('Some assistant content');
    const streaming: StreamingMetadata = {
      chunkCount: 10,
      deltaEvents: [],
    };
    const result = getEventDetail(event, 'clean', streaming);
    expect(result).toBe('[Streamed in 10 chunks]\n\nSome assistant content');
  });

  it('does not show streaming header when no streaming metadata', () => {
    const event = createThoughtEvent('Some thought content');
    const result = getEventDetail(event, 'clean');
    expect(result).toBe('Some thought content');
  });

  it('shows event and deltas separated by --- in raw mode with streaming', () => {
    const event = createThoughtEvent('Some thought content');
    const streaming: StreamingMetadata = {
      chunkCount: 2,
      deltaEvents: [
        {
          id: 'd1',
          type: 'thought_delta',
          createdAt: 1000,
          invocationId: 'inv-1',
          agentName: 'test_agent',
          delta: 'Some ',
          text: 'Some ',
        },
        {
          id: 'd2',
          type: 'thought_delta',
          createdAt: 1001,
          invocationId: 'inv-1',
          agentName: 'test_agent',
          delta: 'thought content',
          text: 'Some thought content',
        },
      ],
    };
    const result = getEventDetail(event, 'raw', streaming);
    expect(result).toContain('"type": "thought"');
    expect(result).toContain('\n\n---\n\n');
    expect(result).toContain('"delta": "Some "');
    expect(result).toContain('"delta": "thought content"');
  });

  it('shows only event in raw mode without streaming', () => {
    const event = createThoughtEvent('Some thought content');
    const result = getEventDetail(event, 'raw');
    expect(result).toContain('"type": "thought"');
    expect(result).not.toContain('---');
  });

  it('shows encrypted indicator grey and dimmed when thought text is empty', () => {
    const event: ThoughtEvent = {
      id: 'thought-1',
      type: 'thought',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'test_agent',
      text: '',
      providerContext: {
        provider: 'openai',
        data: { encrypted_content: 'enc_xyz' },
      },
    };
    expect(getEventDetail(event, 'clean')).toBe('(encrypted)');
    const summary = getEventSummary(event);
    expect(summary.text).toBe('(encrypted)');
    expect(summary.textColor).toBe('gray');
    expect(summary.dimmed).toBe(true);
  });

  it('shows signature grey and dimmed when thought text is empty', () => {
    const event: ThoughtEvent = {
      id: 'thought-1',
      type: 'thought',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'test_agent',
      text: '',
      providerContext: {
        provider: 'gemini',
        data: { thoughtSignature: 'sig_abcdef123456789xyz' },
      },
    };
    expect(getEventDetail(event, 'clean')).toBe('(sig: sig_abcde...)');
    const summary = getEventSummary(event);
    expect(summary.text).toBe('(sig: sig_abcde...)');
    expect(summary.textColor).toBe('gray');
    expect(summary.dimmed).toBe(true);
  });

  it('shows (no content) when thought has no text and no provider context', () => {
    const event: ThoughtEvent = {
      id: 'thought-1',
      type: 'thought',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'test_agent',
      text: '',
    };
    expect(getEventDetail(event, 'clean')).toBe('(no content)');
  });

  it('shows normal thought content without grey text color', () => {
    const event: ThoughtEvent = {
      id: 'thought-1',
      type: 'thought',
      createdAt: Date.now(),
      invocationId: 'inv-1',
      agentName: 'test_agent',
      text: 'Actual thought content',
      providerContext: {
        provider: 'openai',
        data: { encrypted_content: 'enc_xyz' },
      },
    };
    const summary = getEventSummary(event);
    expect(summary.text).toBe('Actual thought content');
    expect(summary.textColor).toBeUndefined();
  });
});
