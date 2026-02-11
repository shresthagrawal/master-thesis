# Fast-Path Recovery for Consensusless Protocols

Master's thesis at the Technical University of Munich (TUM).

We present a recovery protocol for consensusless BFT systems that resolves client equivocation without fallback consensus, preserving single round-trip confirmation latency in the 5f+1 fault model.

## Structure

- `prototype/` -- TypeScript/Node.js reference implementation
- `tex/` -- LaTeX thesis source

## Building the thesis

```bash
cd tex/tumthesis
make thesis.pdf
```
