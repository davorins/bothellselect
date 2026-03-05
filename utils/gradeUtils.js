// utils/gradeUtils.js
/**
 * Grade Calculation Utility
 *
 * Calculates a student's current school grade based on date of birth.
 *
 * Key concept: We use the SCHOOL YEAR, not the calendar year.
 * The school year "2025-2026" is referred to by its START year: 2025.
 *
 * US Default cutoff: August 31 (most states)
 * Other common cutoffs are listed in REGIONAL_CUTOFFS below.
 *
 * If a child is born ON or BEFORE the cutoff date, they start Kindergarten
 * in the fall of the year they turn 5. If AFTER the cutoff, they wait until
 * the following fall (when they turn 6).
 *
 * Example fix:
 *   DOB: 07/05/2014 (July 5, born BEFORE Aug 31 cutoff)
 *   → Kindergarten start fall: 2019
 *   → School year 2025-2026 (schoolYearStart = 2025) → grade = 2025 - 2019 = 6 ✅
 *   Previously: used registrationYear=2026 → 2026 - 2019 = 7 ❌
 */

/**
 * Regional cutoff dates (month is 1-indexed, i.e. September = 9).
 *
 * Format: { month: number (1–12), day: number }
 *
 * United States:
 *   Most states use Sept 1 or Aug 31. Some notable exceptions are listed.
 *   See: https://ecs.org/kindergarten-policies/
 *
 * International:
 *   School year start months vary widely. The cutoff below reflects
 *   the birthday deadline relative to the academic year start.
 */
const REGIONAL_CUTOFFS = {
  // ── United States (by state) ──────────────────────────────────────────────
  US_DEFAULT: { month: 9, day: 1 }, // Sept 1  – majority of US states
  US_WA: { month: 8, day: 31 }, // Aug 31  – Washington
  US_CA: { month: 9, day: 1 }, // Sept 1  – California
  US_TX: { month: 9, day: 1 }, // Sept 1  – Texas
  US_NY: { month: 12, day: 1 }, // Dec 1   – New York
  US_FL: { month: 9, day: 1 }, // Sept 1  – Florida
  US_CT: { month: 1, day: 1 }, // Jan 1   – Connecticut (following year)
  US_NJ: { month: 10, day: 1 }, // Oct 1   – New Jersey
  US_NH: { month: 8, day: 1 }, // Aug 1   – New Hampshire
  US_VA: { month: 9, day: 30 }, // Sept 30 – Virginia
  US_NC: { month: 10, day: 16 }, // Oct 16  – North Carolina
  US_TN: { month: 9, day: 30 }, // Sept 30 – Tennessee
  US_IL: { month: 9, day: 1 }, // Sept 1  – Illinois
  US_OH: { month: 8, day: 1 }, // Aug 1   – Ohio (some districts Sept 30)

  // ── International ─────────────────────────────────────────────────────────
  // Year refers to the academic year that STARTS in the listed month.
  // e.g. UK: school year Sept–Aug, cutoff Aug 31 (must turn 5 before Sept 1)
  UK: { month: 8, day: 31 }, // England/Wales: Aug 31
  UK_SCOTLAND: { month: 2, day: 28 }, // Scotland: Mar 1 (Feb 28/29 cutoff)
  CANADA: { month: 12, day: 31 }, // Most provinces: Dec 31
  AUSTRALIA: { month: 4, day: 30 }, // Most states: Apr 30 (school yr starts Feb)
  AUSTRALIA_VIC: { month: 4, day: 30 }, // Victoria
  AUSTRALIA_NSW: { month: 7, day: 31 }, // New South Wales: Jul 31
  NEW_ZEALAND: { month: 12, day: 31 }, // Dec 31
  GERMANY: { month: 9, day: 30 }, // Sept 30 (varies by Bundesland)
  FRANCE: { month: 12, day: 31 }, // Dec 31
  NETHERLANDS: { month: 10, day: 1 }, // Oct 1
  INDIA: { month: 5, day: 31 }, // May 31 (school yr starts June)
  JAPAN: { month: 4, day: 1 }, // Apr 1 (must turn 6 by Apr 2)
  SOUTH_KOREA: { month: 3, day: 1 }, // Mar 1
  SINGAPORE: { month: 12, day: 31 }, // Dec 31
  UAE: { month: 9, day: 30 }, // Sept 30
};

/**
 * Academic year start months by region (the month the school year begins, 1-indexed).
 * Used to determine whether the current date is in the new school year yet.
 */
const ACADEMIC_YEAR_START_MONTH = {
  US_DEFAULT: 9, // September
  US_WA: 9,
  UK: 9,
  CANADA: 9,
  AUSTRALIA: 2, // February
  AUSTRALIA_NSW: 2,
  NEW_ZEALAND: 2,
  GERMANY: 9,
  FRANCE: 9,
  NETHERLANDS: 9,
  INDIA: 6, // June
  JAPAN: 4, // April
  SOUTH_KOREA: 3, // March
  SINGAPORE: 1, // January
  UAE: 9,
};

/**
 * Determines which school year is currently active, returning its START year.
 *
 * Example: If today is Feb 22, 2026 and school year starts in September:
 *   → The active school year is 2025-2026, so we return 2025.
 *
 * @param {Date} referenceDate  - The date to evaluate (usually today)
 * @param {number} academicYearStartMonth - Month (1-indexed) school year begins
 * @returns {number} The calendar year in which the current school year started
 */
const getCurrentSchoolYearStart = (
  referenceDate = new Date(),
  academicYearStartMonth = 9,
) => {
  const month = referenceDate.getMonth() + 1; // 1-indexed
  const calendarYear = referenceDate.getFullYear();

  // If we're past the school year start month, the school year started this calendar year
  // e.g. today = Feb 2026, start month = Sept → school year started Sept 2025 → return 2025
  if (month < academicYearStartMonth) {
    return calendarYear - 1;
  }
  return calendarYear;
};

/**
 * Main grade calculation function.
 *
 * @param {string|Date} dob             - Student's date of birth
 * @param {number} registrationYear     - The calendar year of registration (used as
 *                                        a hint, but school year is recalculated)
 * @param {string} region               - Key from REGIONAL_CUTOFFS (default: 'US_DEFAULT')
 * @param {Date}   referenceDate        - Date to calculate grade as-of (default: today)
 * @returns {string} Grade: 'PK', 'K', '1'–'12', or '' on error
 */
const calculateGradeFromDOB = (
  dob,
  registrationYear,
  region = 'US_DEFAULT',
  referenceDate = new Date(),
) => {
  if (!dob) return '';

  try {
    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) {
      console.error('Invalid DOB:', dob);
      return '';
    }

    const birthYear = birthDate.getUTCFullYear();
    const birthMonth = birthDate.getUTCMonth() + 1; // 1-indexed
    const birthDay = birthDate.getUTCDate();

    // ── 1. Resolve cutoff for the region ─────────────────────────────────────
    const cutoff = REGIONAL_CUTOFFS[region] || REGIONAL_CUTOFFS['US_DEFAULT'];
    const { month: cutoffMonth, day: cutoffDay } = cutoff;

    // ── 2. Determine academic year START ─────────────────────────────────────
    //    Use registrationYear if provided, otherwise derive from referenceDate.
    //    IMPORTANT: registrationYear is the CALENDAR year of registration (e.g. 2026),
    //    but we need the SCHOOL YEAR start year (e.g. 2025 for the 2025-2026 year).
    const academicStartMonth =
      ACADEMIC_YEAR_START_MONTH[region] ||
      ACADEMIC_YEAR_START_MONTH['US_DEFAULT'];

    let schoolYearStart;
    if (registrationYear) {
      // Re-derive school year start from registrationYear + today's position in the year.
      // This corrects the bug where registrationYear=2026 was used directly even though
      // the 2025-2026 school year hasn't ended yet.
      const refMonth = referenceDate.getMonth() + 1;
      if (refMonth < academicStartMonth) {
        // We're still in the school year that started last calendar year
        schoolYearStart = registrationYear - 1;
      } else {
        // We're in the school year that started this calendar year
        schoolYearStart = registrationYear;
        // Edge case: if registration is for the UPCOMING year (e.g. future event),
        // still correct for current position
        if (referenceDate.getFullYear() < registrationYear) {
          schoolYearStart = getCurrentSchoolYearStart(
            referenceDate,
            academicStartMonth,
          );
        }
      }
    } else {
      schoolYearStart = getCurrentSchoolYearStart(
        referenceDate,
        academicStartMonth,
      );
    }

    // ── 3. Was child born on/before the cutoff? ───────────────────────────────
    //    Determines if they start K in the year they turn 5, or must wait until
    //    the year they turn 6.
    const isOnOrBeforeCutoff =
      birthMonth < cutoffMonth ||
      (birthMonth === cutoffMonth && birthDay <= cutoffDay);

    // ── 4. Kindergarten start year ────────────────────────────────────────────
    //    If born ON or BEFORE cutoff: starts K the fall they turn 5
    //    If born AFTER cutoff: starts K the fall they turn 6
    const kindergartenStartYear = isOnOrBeforeCutoff
      ? birthYear + 5
      : birthYear + 6;

    // ── 5. Grade = school years elapsed since Kindergarten ────────────────────
    const gradeLevel = schoolYearStart - kindergartenStartYear;

    console.log('📚 Grade Calculation:', {
      dob: typeof dob === 'string' ? dob : dob.toISOString(),
      region,
      cutoff: `${cutoffMonth}/${cutoffDay}`,
      birthYear,
      birthMonth,
      birthDay,
      isOnOrBeforeCutoff,
      kindergartenStartYear,
      schoolYearStart,
      gradeLevel,
    });

    // ── 6. Edge cases ─────────────────────────────────────────────────────────
    if (gradeLevel < 0) return 'PK'; // Pre-Kindergarten
    if (gradeLevel === 0) return 'K'; // Kindergarten
    if (gradeLevel > 12) return '12'; // Cap at 12th grade

    return gradeLevel.toString();
  } catch (error) {
    console.error('Error calculating grade from DOB:', error);
    return '';
  }
};

module.exports = {
  calculateGradeFromDOB,
  getCurrentSchoolYearStart,
  REGIONAL_CUTOFFS,
  ACADEMIC_YEAR_START_MONTH,
};
