import { describe, expect, it } from 'vitest';
import { captureTraceFromTranscriptText } from '../../../tests/scientific/runner/trace_capture';

describe('trace capture final assistant text surface', () => {
  it('preserves all text blocks from the final assistant message', () => {
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'older block' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'SHAPE_CHOICE: A reason=small\nTRACE: build_from_graph\nSMILES: C1CCCCC1',
            },
            {
              type: 'text',
              text: 'MIRROR_CHECK: ok',
            },
          ],
        },
      }),
    ].join('\n');

    const trace = captureTraceFromTranscriptText(transcript, '/tmp/transcript.jsonl');

    expect(trace.final_assistant_text).toContain('SHAPE_CHOICE: A');
    expect(trace.final_assistant_text).toContain('MIRROR_CHECK: ok');
    expect(trace.final_assistant_text).not.toContain('older block');
    expect(trace.final_assistant_text_blocks).toEqual([
      'SHAPE_CHOICE: A reason=small\nTRACE: build_from_graph\nSMILES: C1CCCCC1',
      'MIRROR_CHECK: ok',
    ]);
  });
});

describe('trace capture image-rebuild v3 surfaces', () => {
  it('exposes every assistant message in assistant_message_blocks', () => {
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first message prose' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'second message line A' },
            { type: 'text', text: 'second message line B' },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'SMILES: C1CCCCC1' }] },
      }),
    ].join('\n');

    const trace = captureTraceFromTranscriptText(transcript, '/tmp/t.jsonl');
    expect(trace.assistant_message_blocks).toEqual([
      'first message prose',
      'second message line A\n\nsecond message line B',
      'SMILES: C1CCCCC1',
    ]);
    expect(trace.num_assistant_messages).toBe(3);
  });

  it('emits validate_graph / crop_source_image / refuse events for image-rebuild tools', () => {
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_v1',
              name: 'mcp__heimdall__validate_graph',
              input: { graph: { atoms: [] } },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_c1',
              name: 'mcp__heimdall__crop_source_image',
              input: { x: 100, y: 200, w: 64, h: 64 },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_r1',
              name: 'mcp__heimdall__refuse',
              input: { pixel_evidence: 'arrow + multi-substrate panel' },
            },
          ],
        },
      }),
    ].join('\n');

    const trace = captureTraceFromTranscriptText(transcript, '/tmp/t.jsonl');
    const labels = trace.events.map((e) => e.label);
    expect(labels).toContain('validate_graph');
    expect(labels).toContain('crop_source_image');
    expect(labels).toContain('refuse');
  });

  it('pairs tool_use with tool_result so events carry backend classification', () => {
    const refusePayload = {
      accepted: true,
      backend_classification: 'reaction_input',
    };
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_r9',
              name: 'mcp__heimdall__refuse',
              input: { pixel_evidence: 'reaction arrow visible mid-image' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_r9',
              content: [{ type: 'text', text: JSON.stringify(refusePayload) }],
            },
          ],
        },
      }),
    ].join('\n');

    const trace = captureTraceFromTranscriptText(transcript, '/tmp/t.jsonl');
    const refuseEvent = trace.events.find((e) => e.label === 'refuse');
    expect(refuseEvent).toBeDefined();
    expect(refuseEvent?.tool_use_id).toBe('toolu_r9');
    expect(refuseEvent?.result).toEqual(refusePayload);
  });

  it('emits a Read label alongside vision_identify_structure for image-file reads', () => {
    // Image-rebuild v3 phase 5 (closes the latent transcript_image_input_gate
    // ↔ Read-label mismatch). Real agent-orch traces previously only carried
    // `vision_identify_structure` on the image-Read branch; the gate scanned
    // for `Read`/`read` labels and silently failed every row.
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read1',
              name: 'Read',
              input: { file_path: '/fixtures/I001/molecule.png' },
            },
          ],
        },
      }),
    ].join('\n');

    const trace = captureTraceFromTranscriptText(transcript, '/tmp/t.jsonl');
    const labels = trace.events.map((e) => e.label);
    expect(labels).toContain('Read');
    expect(labels).toContain('vision_identify_structure');
    const readEvent = trace.events.find((e) => e.label === 'Read');
    expect(readEvent?.path).toBe('/fixtures/I001/molecule.png');
  });

  it('pairs validate_graph result fields onto the captured event', () => {
    const validatePayload = { ok: true };
    const transcript = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_v2',
              name: 'mcp__heimdall__validate_graph',
              input: { graph: { atoms: [] } },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_v2',
              content: [{ type: 'text', text: JSON.stringify(validatePayload) }],
            },
          ],
        },
      }),
    ].join('\n');

    const trace = captureTraceFromTranscriptText(transcript, '/tmp/t.jsonl');
    const validateEvent = trace.events.find((e) => e.label === 'validate_graph');
    expect(validateEvent?.result).toEqual(validatePayload);
  });
});
