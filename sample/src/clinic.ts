/**
 * The clinic's world: the slots the agent may offer, and the ledger it writes to.
 *
 * All of it is invented, and all of it lives in this one file on purpose — the sample runs with no
 * database, no container, and no network. Replace these functions with real queries and nothing
 * above them changes: the agent only ever sees the tools, never the storage.
 */

export const SERVICES = ['physiotherapy', 'dental-hygiene', 'eye-test'] as const

export type Service = (typeof SERVICES)[number]

export interface Slot {
  id: string
  service: Service
  clinician: string
  day: string
  time: string
}

export interface Booking {
  reference: string
  slotId: string
  service: Service
  clinician: string
  day: string
  time: string
  bookedFor: string
}

/** The week, as `[id, service, clinician, day, time]`. Weekday names never go stale. */
const TIMETABLE = [
  ['slot-01', 'physiotherapy', 'R. Ellis', 'Monday', '09:15'],
  ['slot-02', 'physiotherapy', 'R. Ellis', 'Tuesday', '14:30'],
  ['slot-03', 'physiotherapy', 'J. Okafor', 'Tuesday', '16:00'],
  ['slot-04', 'dental-hygiene', 'M. Haas', 'Tuesday', '11:00'],
  ['slot-05', 'dental-hygiene', 'M. Haas', 'Thursday', '15:45'],
  ['slot-06', 'eye-test', 'S. Vance', 'Wednesday', '10:30'],
  ['slot-07', 'eye-test', 'S. Vance', 'Friday', '13:00'],
] as const satisfies ReadonlyArray<readonly [string, Service, string, string, string]>

const SLOTS: readonly Slot[] = TIMETABLE.map(([id, service, clinician, day, time]) => ({
  id,
  service,
  clinician,
  day,
  time,
}))

/** Bookings, by slot id. In a real app a table; here a Map, and that is the whole point. */
const ledger = new Map<string, Booking>()

let nextReference = 1

/** Open slots. An omitted filter matches everything. */
export function openSlots(filter: { service?: Service; day?: string } = {}): Slot[] {
  const day = filter.day?.toLowerCase()
  return SLOTS.filter(
    (slot) =>
      !ledger.has(slot.id) &&
      (filter.service === undefined || slot.service === filter.service) &&
      (day === undefined || slot.day.toLowerCase() === day),
  )
}

export function findSlot(slotId: string): Slot | undefined {
  return SLOTS.find((slot) => slot.id === slotId)
}

export function isBooked(slotId: string): boolean {
  return ledger.has(slotId)
}

/** The side effect the human is approving. */
export function bookSlot(slot: Slot, bookedFor: string): Booking {
  const booking: Booking = {
    reference: `CLINIC-${String(nextReference++).padStart(3, '0')}`,
    slotId: slot.id,
    service: slot.service,
    clinician: slot.clinician,
    day: slot.day,
    time: slot.time,
    bookedFor,
  }
  ledger.set(slot.id, booking)
  return booking
}

/** Empty the ledger. Tests call this between cases; the CLI never does. */
export function resetClinic(): void {
  ledger.clear()
  nextReference = 1
}
