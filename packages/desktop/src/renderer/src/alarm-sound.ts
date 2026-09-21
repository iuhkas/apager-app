/** Zweiton-Signal per Web Audio - so muss keine Audiodatei mitgeliefert werden. */
let context: AudioContext | null = null

export function playAlarmSound(repeats = 3): void {
  context ??= new AudioContext()
  void context.resume()
  const start = context.currentTime + 0.05

  for (let i = 0; i < repeats; i++) {
    for (const [index, frequency] of [880, 660].entries()) {
      const at = start + i * 0.9 + index * 0.45
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'square'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.45)
    }
  }
}
