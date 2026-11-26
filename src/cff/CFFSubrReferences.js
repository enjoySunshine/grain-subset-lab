// Fast CFF charstring walk used by subsetting.
//
// Subsetting keeps every subroutine slot in place. Used subroutines are
// copied and unused slots are written as a one-byte return. Consequently the
// only information needed here is the set of global and local subroutine
// indices reached by a glyph. Building Path objects and evaluating drawing
// coordinates would repeat work that encoding does not need.

function biasFor(subrs) {
  const length = subrs?.length || 0;
  if (length < 1240) {
    return 107;
  }

  if (length < 33900) {
    return 1131;
  }

  return 32768;
}

export default function collectCFFSubrReferences(cff, gid, usage = {}) {
  const charString = cff.topDict.CharStrings[gid];
  const privateDict = cff.privateDictForGlyph(gid) || {};
  const subrs = privateDict.Subrs || [];
  const globalSubrs = cff.globalSubrIndex || [];
  const subrsBias = biasFor(subrs);
  const globalSubrsBias = biasFor(globalSubrs);

  // Subsetting aggregates local usage by FD and global usage for the whole
  // font. Callers can therefore pass the aggregate sets directly and avoid
  // allocating and merging one set per glyph.
  const usedSubrs = usage.usedSubrs || Object.create(null);
  const usedGlobalSubrs = usage.usedGlobalSubrs || Object.create(null);

  // DecodeStream keeps the complete backing byte array. Direct indexed reads
  // are smaller/faster here than going through DataView getters for every byte.
  const bytes = cff.stream.buffer;

  const stack = [];
  const transient = [];
  let nStems = 0;
  let width = null;

  function checkWidth() {
    if (width == null) {
      width = stack.shift() + (privateDict.nominalWidthX || 0);
    }
  }

  function parseStems() {
    if (stack.length % 2 !== 0) {
      checkWidth();
    }

    nStems += stack.length >> 1;
    stack.length = 0;
  }

  function run(offset, length) {
    let pos = offset;
    const end = offset + length;

    while (pos < end) {
      const op = bytes[pos++];

      if (op === 28) {
        let value = (bytes[pos] << 8) | bytes[pos + 1];
        if (value & 0x8000) value -= 0x10000;
        stack.push(value);
        pos += 2;
      } else if (op >= 32 && op < 247) {
        stack.push(op - 139);
      } else if (op >= 247 && op < 251) {
        const b1 = bytes[pos++];
        stack.push((op - 247) * 256 + b1 + 108);
      } else if (op >= 251 && op < 255) {
        const b1 = bytes[pos++];
        stack.push(-(op - 251) * 256 - b1 - 108);
      } else if (op === 255) {
        stack.push(
          ((bytes[pos] << 24) |
            (bytes[pos + 1] << 16) |
            (bytes[pos + 2] << 8) |
            bytes[pos + 3]) /
            65536,
        );
        pos += 4;
      } else if (op < 32) {
        let index;
        let a;
        let b;

        switch (op) {
          case 1: // hstem
          case 3: // vstem
          case 18: // hstemhm
          case 23: // vstemhm
            parseStems();
            break;

          case 19: // hintmask
          case 20: // cntrmask
            parseStems();
            pos += (nStems + 7) >> 3;
            break;

          case 10: {
            // callsubr
            index = stack.pop() + subrsBias;
            const subr = subrs[index];
            if (subr) {
              usedSubrs[index] = true;
              run(subr.offset, subr.length);
            }
            break;
          }

          case 11: // return
            return;

          case 14: // endchar
            return;

          case 12: {
            const op2 = bytes[pos++];
            switch (op2) {
              case 3: // and
                a = stack.pop();
                b = stack.pop();
                stack.push(a && b ? 1 : 0);
                break;

              case 4: // or
                a = stack.pop();
                b = stack.pop();
                stack.push(a || b ? 1 : 0);
                break;

              case 5: // not
                a = stack.pop();
                stack.push(a ? 0 : 1);
                break;

              case 9: // abs
                a = stack.pop();
                stack.push(Math.abs(a));
                break;

              case 10: // add
                a = stack.pop();
                b = stack.pop();
                stack.push(a + b);
                break;

              case 11: // sub
                a = stack.pop();
                b = stack.pop();
                stack.push(a - b);
                break;

              case 12: // div
                a = stack.pop();
                b = stack.pop();
                stack.push(a / b);
                break;

              case 14: // neg
                a = stack.pop();
                stack.push(-a);
                break;

              case 15: // eq
                a = stack.pop();
                b = stack.pop();
                stack.push(a === b ? 1 : 0);
                break;

              case 18: // drop
                stack.pop();
                break;

              case 20: {
                // put
                const value = stack.pop();
                index = stack.pop();
                transient[index] = value;
                break;
              }

              case 21: // get
                index = stack.pop();
                stack.push(transient[index] || 0);
                break;

              case 22: {
                // ifelse
                const s1 = stack.pop();
                const s2 = stack.pop();
                const v1 = stack.pop();
                const v2 = stack.pop();
                stack.push(v1 <= v2 ? s1 : s2);
                break;
              }

              case 23: // random
                // The outline parser uses Math.random(). A random subroutine
                // index would make subset output unstable, so real fonts do
                // not use it to reach subroutines. Zero keeps this walk
                // deterministic.
                stack.push(0);
                break;

              case 24: // mul
                a = stack.pop();
                b = stack.pop();
                stack.push(a * b);
                break;

              case 26: // sqrt
                a = stack.pop();
                stack.push(Math.sqrt(a));
                break;

              case 27: // dup
                a = stack.pop();
                stack.push(a, a);
                break;

              case 28: // exch
                a = stack.pop();
                b = stack.pop();
                stack.push(b, a);
                break;

              case 29: // index
                index = stack.pop();
                if (index < 0) {
                  index = 0;
                } else if (index > stack.length - 1) {
                  index = stack.length - 1;
                }

                stack.push(stack[index]);
                break;

              case 30: {
                // roll
                let n = stack.pop();
                let j = stack.pop();

                if (j >= 0) {
                  while (j > 0) {
                    const t = stack[n - 1];
                    for (let i = n - 2; i >= 0; i--) {
                      stack[i + 1] = stack[i];
                    }

                    stack[0] = t;
                    j--;
                  }
                } else {
                  while (j < 0) {
                    const t = stack[0];
                    for (let i = 0; i <= n; i++) {
                      stack[i] = stack[i + 1];
                    }

                    stack[n - 1] = t;
                    j++;
                  }
                }
                break;
              }

              default:
                // Drawing/flex operators consume their operands. Their exact
                // geometric effect is not needed to discover calls.
                stack.length = 0;
            }
            break;
          }

          case 29: {
            // callgsubr
            index = stack.pop() + globalSubrsBias;
            const subr = globalSubrs[index];
            if (subr) {
              usedGlobalSubrs[index] = true;
              run(subr.offset, subr.length);
            }
            break;
          }

          default:
            // All other ordinary operators consume the current operand stack.
            stack.length = 0;
        }
      }
    }
  }

  run(charString.offset, charString.length);

  return {
    usedSubrs,
    usedGlobalSubrs,
  };
}
