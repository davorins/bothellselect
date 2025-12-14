// backend/utils/gradeUtils.js
const calculateGradeFromDOB = (dob, registrationYear) => {
  if (!dob || !registrationYear) return '';

  try {
    const birthDate = new Date(dob);
    const birthYear = birthDate.getUTCFullYear();
    const birthMonth = birthDate.getUTCMonth() + 1; // Convert to 1-indexed (Jan = 1)
    const birthDay = birthDate.getUTCDate();

    console.log('🔍 Backend Grade Calculation:', {
      dob,
      registrationYear,
      birthYear,
      birthMonth,
      birthDay,
    });

    // Washington state cutoff: Students must be 5 by August 31st to start Kindergarten
    const cutoffMonth = 8; // August (1-indexed)
    const cutoffDay = 31;

    // Determine if child was born before cutoff (on or before August 31)
    const isBeforeCutoff =
      birthMonth < cutoffMonth ||
      (birthMonth === cutoffMonth && birthDay <= cutoffDay);

    // Kindergarten start year calculation
    const kindergartenStartYear = isBeforeCutoff
      ? birthYear + 5
      : birthYear + 6;

    // Calculate grade level
    const gradeLevel = registrationYear - kindergartenStartYear;

    console.log('🔍 Backend Grade Result:', {
      isBeforeCutoff,
      kindergartenStartYear,
      gradeLevel,
    });

    // Handle edge cases
    if (gradeLevel < 0) return 'PK'; // Pre-Kindergarten
    if (gradeLevel === 0) return 'K'; // Kindergarten
    if (gradeLevel > 12) return '12'; // Maximum 12th grade

    return gradeLevel.toString();
  } catch (error) {
    console.error('Error calculating grade from DOB:', error);
    return '';
  }
};

module.exports = { calculateGradeFromDOB };
