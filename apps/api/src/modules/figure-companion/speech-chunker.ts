const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':']);

/**
 * Turns arbitrarily-sized LLM deltas into natural TTS chunks. Complete
 * sentences are emitted immediately. Long sentences may be split at a
 * natural pause so the first audio can start without waiting for the model.
 */
export class SpeechChunker {
  private buffer = '';
  private emittedAny = false;

  constructor(
    private readonly minimumSentenceLength = 5,
    private readonly firstSoftBreakLength = 22,
    private readonly softBreakLength = 24,
    private readonly hardBreakLength = 40,
  ) {}

  push(delta: string) {
    if (!delta) return [];
    this.buffer += delta;
    return this.takeReady(false);
  }

  flush() {
    return this.takeReady(true);
  }

  /**
   * Releases a short, safe prefix when the model has started producing text
   * but has not reached punctuation yet. Callers use this after a tiny grace
   * period so the first TTS request can overlap the rest of the LLM stream.
   * Stage directions such as `（轻笑）` do not count toward the spoken length
   * and a chunk is never cut while a bracket is still open.
   */
  takeEarlyFragment(minimumSpokenLength = 3, maximumSpokenLength = 6) {
    if (this.emittedAny || minimumSpokenLength < 1) return [];

    const trimmedBuffer = this.buffer.trimEnd();
    const lastCharacter = trimmedBuffer[trimmedBuffer.length - 1];
    // A comma/colon explicitly tells us that the thought continues. Waiting
    // for the following clause sounds much more natural than producing two
    // tiny WAV files with a network gap between them.
    if (lastCharacter && SOFT_BREAKS.has(lastCharacter)) return [];

    const maximum = Math.max(minimumSpokenLength, maximumSpokenLength);
    let bracketDepth = 0;
    let spokenLength = 0;
    let end = -1;

    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      if ('（(【['.includes(character)) {
        bracketDepth += 1;
        continue;
      }
      if ('）)】]'.includes(character)) {
        if (bracketDepth > 0) bracketDepth -= 1;
        continue;
      }
      if (bracketDepth > 0 || /\s/.test(character)) continue;
      if (SENTENCE_ENDINGS.has(character) || SOFT_BREAKS.has(character)) {
        continue;
      }

      spokenLength += 1;
      if (spokenLength >= minimumSpokenLength) end = index + 1;
      if (spokenLength >= maximum) break;
    }

    if (end < 0) return [];
    const chunk = this.buffer.slice(0, end).trim();
    if (!chunk) return [];
    this.buffer = this.buffer.slice(end);
    this.emittedAny = true;
    return [chunk];
  }

  private takeReady(flush: boolean) {
    const chunks: string[] = [];
    let start = 0;
    let lastSoftBreak = -1;
    let bracketDepth = 0;
    let spokenLength = 0;

    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      if ('（(【['.includes(character)) bracketDepth += 1;
      if ('）)】]'.includes(character) && bracketDepth > 0) bracketDepth -= 1;
      if (bracketDepth > 0) continue;

      if (!/\s/.test(character)) spokenLength += 1;

      if (SOFT_BREAKS.has(character)) lastSoftBreak = index;
      const preferredSoftBreakLength = this.emittedAny
        ? this.softBreakLength
        : this.firstSoftBreakLength;
      let end = -1;
      if (
        SENTENCE_ENDINGS.has(character) &&
        (flush || spokenLength >= this.minimumSentenceLength)
      ) {
        end = index + 1;
      } else if (
        SOFT_BREAKS.has(character) &&
        spokenLength >= preferredSoftBreakLength
      ) {
        end = index + 1;
      } else if (spokenLength >= this.hardBreakLength) {
        end = lastSoftBreak >= start ? lastSoftBreak + 1 : index + 1;
      }

      if (end <= start) continue;
      const chunk = this.buffer.slice(start, end).trim();
      if (chunk) {
        chunks.push(chunk);
        this.emittedAny = true;
      }
      start = end;
      lastSoftBreak = -1;
      spokenLength = 0;
      index = start - 1;
    }

    this.buffer = this.buffer.slice(start);
    if (flush) {
      const tail = this.buffer.trim();
      if (tail) {
        chunks.push(tail);
        this.emittedAny = true;
      }
      this.buffer = '';
    }
    return chunks;
  }
}
