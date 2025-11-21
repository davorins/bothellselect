function normalizeSchoolName(name) {
  return name
    .toLowerCase()
    .split(' ')
    .filter((word) => word.trim() !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

module.exports = normalizeSchoolName;
