// utils/gradeUtils.js
const calculateGradeFromDOB = (dob, currentYear) => {
  if (!dob) return '';

  const birthDate = new Date(dob);
  const birthYear = birthDate.getUTCFullYear();

  // Washington state cutoff (August 31st)
  const cutoffMonth = 7; // August (0-indexed)
  const cutoffDay = 31;

  // Determine academic year (current year if after cutoff, previous year if before)
  const today = new Date();
  const academicYear =
    today.getMonth() > cutoffMonth ||
    (today.getMonth() === cutoffMonth && today.getDate() >= cutoffDay)
      ? currentYear
      : currentYear - 1;

  let baseGrade = academicYear - birthYear - 5; // Adjust for typical K start age

  // Handle edge cases
  if (baseGrade < 0) return 'PK'; // Pre-K
  if (baseGrade === 0) return 'K'; // Kindergarten
  if (baseGrade > 12) return '12'; // Max grade

  return baseGrade.toString();
};

module.exports = { calculateGradeFromDOB };
