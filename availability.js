/* ============================================================
   AUTO FLUCHOS COCHES — shared availability engine
   Single source of truth for "is this car/unit free" math, used by both
   index.html (public site) and admin.html (admin dashboard) so the two
   pages can never silently disagree with each other again. Mirrors the
   backend's CAR_TURNAROUND_BUFFER_MS / rangesOverlap_ in apps-script.gs.txt
   exactly (same buffer value, same bidirectional overlap formula) — if that
   backend constant ever changes, BUFFER_MS below must be updated to match.

   Every function here is pure: it takes the caller's own data as plain
   arguments (bookings/unitIds/stock/dates) and returns a result — nothing
   here reads index.html's or admin.html's global state directly. Each host
   page is responsible for mapping its own booking/unit data into the shapes
   documented below before calling in.

   Data shapes:
     Booking  = { pickup: ISOString, ret: ISOString, unitId: string|null }
     unitIds  = string[]  (opaque unit ids; omit/empty when the car has no
                registered fleet units yet, which falls back to plain
                stock-count math everywhere below)
   ============================================================ */
(function(global){
  const BUFFER_MS = 2 * 60 * 60 * 1000; // 2h turnaround buffer — mirrors the backend

  /* True if [startA, endA) conflicts with [startB, endB) once the mandatory
     buffer gap is required between one range's end and the other's start —
     bidirectional, exactly matching the backend's rangesOverlap_. */
  function rangesOverlap(startA, endA, startB, endB, bufferMs){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    return new Date(startB).getTime() < new Date(endA).getTime() + bufferMs &&
           new Date(startA).getTime() < new Date(endB).getTime() + bufferMs;
  }

  /* How many of `bookings` overlap the given [pickupVal, retVal) range. */
  function getOverlapCount(bookings, pickupVal, retVal, bufferMs){
    if(!bookings || !pickupVal || !retVal) return 0;
    return bookings.filter(b => rangesOverlap(pickupVal, retVal, b.pickup, b.ret, bufferMs)).length;
  }

  /* How many units are free at the single instant `t` (ms epoch) — the core
     primitive every day/range check below is built from. Unit-aware when
     `unitIds` is populated (a legacy booking with no unitId still consumes
     one anonymous slot, since it's a real physical car even if it predates
     unit tracking); otherwise a plain stock-count fallback. */
  function freeCountAt(bookings, unitIds, stock, t, bufferMs){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    const active = (bookings || []).filter(b => {
      const s = new Date(b.pickup).getTime() - bufferMs;
      const e = new Date(b.ret).getTime() + bufferMs;
      return s <= t && t < e;
    });
    if(unitIds && unitIds.length){
      const assignedUnitIds = active.filter(b => b.unitId).map(b => b.unitId);
      const legacyCount = active.filter(b => !b.unitId).length;
      const freeUnits = unitIds.filter(id => assignedUnitIds.indexOf(id) === -1);
      return Math.max(0, freeUnits.length - legacyCount);
    }
    return Math.max(0, (stock || 0) - active.length);
  }

  /* Remaining units of a car for a specific [pickupVal, retVal) range —
     unit-aware overlap-based check, falling back to plain stock-vs-overlap
     when the car has no registered fleet units. Returns `stock` unchanged
     when no range is supplied yet (nothing to check against). */
  function getRemainingStockForRange({ bookings, unitIds, stock, pickupVal, retVal, bufferMs }){
    bookings = bookings || [];
    if(!pickupVal || !retVal) return stock;
    if(!unitIds || !unitIds.length){
      const overlap = getOverlapCount(bookings, pickupVal, retVal, bufferMs);
      return Math.max(0, stock - overlap);
    }
    const overlapping = bookings.filter(b => rangesOverlap(pickupVal, retVal, b.pickup, b.ret, bufferMs));
    const assignedOverlapUnitIds = overlapping.filter(b => b.unitId).map(b => b.unitId);
    const legacyOverlapCount = overlapping.filter(b => !b.unitId).length;
    const freeUnits = unitIds.filter(id => assignedOverlapUnitIds.indexOf(id) === -1);
    return Math.max(0, freeUnits.length - legacyOverlapCount);
  }

  /* The earliest moment AT OR AFTER `afterMs` (on the SAME calendar day)
     that has a free slot — used for the "delayed" same-day rescue search.
     `unitIds` is optional here on purpose: getDelayedAvailability below
     intentionally calls this WITHOUT unitIds (aggregate-only) to preserve
     the exact pre-existing behavior of index.html's/admin.html's original
     functions — the per-unit precision is applied by the subsequent
     getRemainingStockForRange call instead. findNextAvailableMoment (the
     new multi-day search) DOES pass unitIds for full per-unit precision. */
  function getEarliestTimeAfter({ bookings, unitIds, stock, afterMs, bufferMs }){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    bookings = bookings || [];
    const afterDate = new Date(afterMs);
    const dayStartMs = new Date(afterDate.getFullYear(), afterDate.getMonth(), afterDate.getDate()).getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const candidates = bookings
      .map(b => new Date(b.ret).getTime() + bufferMs)
      .filter(t => t >= afterMs && t < dayEndMs)
      .sort((a, b) => a - b);
    for(const t of candidates){
      if(freeCountAt(bookings, unitIds, stock, t, bufferMs) > 0) return new Date(t);
    }
    return null;
  }

  /* Three-state availability check: 'available' (free at the exact
     requested pickup/return), 'delayed' (not free at the exact requested
     time, but WOULD be free later the SAME pickup day), or 'unavailable'
     (no same-day rescue). See findNextAvailableMoment for the multi-day
     equivalent used once this returns 'unavailable'. */
  function getDelayedAvailability({ bookings, unitIds, stock, pickupVal, retVal, bufferMs }){
    if(!pickupVal || !retVal) return { status: 'unknown' };
    const remaining = getRemainingStockForRange({ bookings, unitIds, stock, pickupVal, retVal, bufferMs });
    if(remaining > 0) return { status: 'available', remaining, effectivePickup: pickupVal };
    const [pickupDateStr] = pickupVal.split('T');
    const [y, m, d] = pickupDateStr.split('-').map(Number);
    if(!y || !m || !d) return { status: 'unavailable' };
    const earliest = getEarliestTimeAfter({ bookings, stock, afterMs: new Date(pickupVal).getTime(), bufferMs });
    if(!earliest) return { status: 'unavailable' };
    const pad = n => String(n).padStart(2, '0');
    const earliestTimeStr = `${pad(earliest.getHours())}:${pad(earliest.getMinutes())}`;
    const delayedPickup = `${pickupDateStr}T${earliestTimeStr}`;
    const delayedRemaining = getRemainingStockForRange({ bookings, unitIds, stock, pickupVal: delayedPickup, retVal, bufferMs });
    if(delayedRemaining > 0){
      return { status: 'delayed', remaining: delayedRemaining, effectivePickup: delayedPickup, earliestTimeStr, pickupDateStr };
    }
    return { status: 'unavailable' };
  }

  /* True if `cellDate` has NO valid moment left to book at all — i.e. every
     instant of the day has zero free units. Scans only the moments where
     the free count can actually change (day start, and each booking's
     buffered end that falls within the day) rather than every minute, so a
     day that STARTS booked but frees up partway through is correctly NOT
     marked fully booked (the historical bug: a pickup at 18:00 used to
     black out the whole day instead of just 00:00–16:00). */
  function isDayFullyBooked({ bookings, unitIds, stock, cellDate, bufferMs }){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    bookings = bookings || [];
    const dayStartMs = new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate()).getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const endTimes = bookings
      .map(b => new Date(b.ret).getTime() + bufferMs)
      .filter(t => t > dayStartMs && t < dayEndMs);
    const candidates = [dayStartMs, ...endTimes];
    return !candidates.some(t => freeCountAt(bookings, unitIds, stock, t, bufferMs) > 0);
  }

  /* The earliest bookable moment on `cellDate` — unit-aware when `unitIds`
     is supplied. Falls back to the start of the day when nothing on this
     day restricts it. */
  function getEarliestTimeOnDay({ bookings, unitIds, stock, cellDate, bufferMs }){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    bookings = bookings || [];
    const dayStart = new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const candidates = [dayStartMs, ...bookings
      .map(b => new Date(b.ret).getTime() + bufferMs)
      .filter(t => t > dayStartMs && t < dayEndMs)].sort((a, b) => a - b);
    for(const t of candidates){
      if(freeCountAt(bookings, unitIds, stock, t, bufferMs) > 0) return new Date(t);
    }
    return dayStart;
  }

  /* The LATEST valid RETURN moment on `cellDate` given a FIXED pickup
     (`pickupVal`) — the mirror image of getEarliestTimeOnDay, which anchors
     a candidate PICKUP at the earliest free moment of a day. This exists so
     a return-date picker never blacks out an entire day just because
     whatever return TIME happens to be sitting in the field is later than
     the actual cutoff: e.g. an upcoming reservation pickup at 14:00 with a
     2h buffer means the latest valid return that day is 12:00 — the day
     itself must stay selectable, with only times after 12:00 blocked.
     Scans candidates in descending order (end of day, and each upcoming
     booking's buffered START that falls within the day — the instant right
     before its exclusion zone begins) and returns the first one where the
     FULL [pickupVal, candidate) range is actually free (a real range check,
     not just a single-instant one, so any OTHER conflict between pickupVal
     and the candidate is still caught). Returns null if no valid return
     moment exists on this day at all. */
  function getLatestValidReturnTime({ bookings, unitIds, stock, pickupVal, cellDate, bufferMs }){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    bookings = bookings || [];
    const dayStart = new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const candidates = [dayEndMs - 1, ...bookings
      .map(b => new Date(b.pickup).getTime() - bufferMs)
      .filter(t => t > dayStartMs && t < dayEndMs)].sort((a, b) => b - a);
    for(const t of candidates){
      const remaining = getRemainingStockForRange({ bookings, unitIds, stock, pickupVal, retVal: new Date(t).toISOString(), bufferMs });
      if(remaining > 0) return new Date(t);
    }
    return null;
  }

  /* NEW: finds the true next-available moment, searching forward across
     MULTIPLE DAYS (not just the same day) when no same-day rescue exists —
     powers "this car isn't free now, but it will be from {date} {time}"
     messaging even when several consecutive bookings are in the way.
     Unit-aware throughout. Only evaluates the sorted list of booking
     start/end (buffered) boundaries within the search window — O(n log n)
     in the car's own booking count, not a per-minute/per-day brute loop.
     Returns { found:false } if nothing opens up within `maxDays`. */
  function findNextAvailableMoment({ bookings, unitIds, stock, fromMs, bufferMs, maxDays, minDurationMs }){
    bufferMs = bufferMs == null ? BUFFER_MS : bufferMs;
    maxDays = maxDays || 60;
    minDurationMs = minDurationMs || 0;
    bookings = bookings || [];

    const fitsFrom = t => !minDurationMs || freeCountAt(bookings, unitIds, stock, t + minDurationMs - 1, bufferMs) > 0;

    // Fast path: same-day rescue, fully unit-aware (unlike
    // getDelayedAvailability's internal use of this same function, this
    // caller DOES pass unitIds, since here there's no separate range
    // re-check afterward to catch an imprecise aggregate guess).
    const sameDay = getEarliestTimeAfter({ bookings, unitIds, stock, afterMs: fromMs, bufferMs });
    if(sameDay && fitsFrom(sameDay.getTime())) return { found: true, moment: sameDay };

    const horizonMs = fromMs + maxDays * 24 * 60 * 60 * 1000;
    const boundarySet = new Set();
    bookings.forEach(b => {
      const s = new Date(b.pickup).getTime() - bufferMs;
      const e = new Date(b.ret).getTime() + bufferMs;
      if(e > fromMs && e <= horizonMs) boundarySet.add(e);
      if(s > fromMs && s <= horizonMs) boundarySet.add(s);
    });
    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);
    for(const t of boundaries){
      if(freeCountAt(bookings, unitIds, stock, t, bufferMs) > 0 && fitsFrom(t)){
        return { found: true, moment: new Date(t) };
      }
    }
    return { found: false };
  }

  global.Availability = {
    BUFFER_MS,
    rangesOverlap,
    getOverlapCount,
    getRemainingStockForRange,
    getDelayedAvailability,
    isDayFullyBooked,
    getEarliestTimeOnDay,
    getLatestValidReturnTime,
    findNextAvailableMoment,
  };
})(window);
