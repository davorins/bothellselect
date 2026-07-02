const moment = require('moment');

class CalendarDateGenerator {
  constructor(year = new Date().getFullYear()) {
    this.year = year;
  }

  getImportantDates() {
    const dates = [];
    const currentYear = this.year;

    // Color mapping
    const colorMap = {
      training: '#1abe17',
      game: '#dc3545',
      holidays: '#0f65cd',
      celebration: '#eab300',
      camp: '#9b25b7',
      tryout: '#0d6efd',
    };

    // US Federal Holidays for 2026 - make them all-day events
    const holidays = [
      {
        title: "New Year's Day",
        date: `${currentYear}-01-01T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Martin Luther King Jr. Day',
        date: `${this.getMLKDay(currentYear)}T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: "Presidents' Day",
        date: `${this.getPresidentsDay(currentYear)}T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Memorial Day',
        date: `${this.getMemorialDay(currentYear)}T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Juneteenth',
        date: `${currentYear}-06-19`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Independence Day',
        date: `${currentYear}-07-04`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Labor Day',
        date: `${this.getLaborDay(currentYear)}T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Columbus Day',
        date: `${this.getColumbusDay(currentYear)}T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Veterans Day',
        date: `${currentYear}-11-11`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Thanksgiving Day',
        date: `${this.getThanksgiving(currentYear)}T00:00:00`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
      {
        title: 'Christmas Day',
        date: `${currentYear}-12-25`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
        allDay: true,
      },
    ];

    // Sports/Team Milestones for 2026
    const seasonMilestones = [
      {
        title: 'Season Registration Opens',
        date: `${currentYear}-01-15`,
        category: 'training',
        backgroundColor: colorMap.training,
      },
      {
        title: 'Pre-Season Training Starts',
        date: `${currentYear}-02-01`,
        category: 'training',
        backgroundColor: colorMap.training,
      },
      {
        title: 'Regular Season Begins',
        date: `${currentYear}-03-15`,
        category: 'game',
        backgroundColor: colorMap.game,
      },
      {
        title: 'Mid-Season Break',
        date: `${currentYear}-06-01`,
        endDate: `${currentYear}-06-07`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
      },
      {
        title: 'Playoffs Begin',
        date: `${currentYear}-08-01`,
        category: 'game',
        backgroundColor: colorMap.game,
      },
      {
        title: 'Championship Games',
        date: `${currentYear}-09-15`,
        category: 'game',
        backgroundColor: colorMap.game,
      },
      {
        title: 'End of Season Banquet',
        date: `${currentYear}-10-01`,
        category: 'celebration',
        backgroundColor: colorMap.celebration,
      },
      {
        title: 'Off-Season Training',
        date: `${currentYear}-11-01`,
        category: 'training',
        backgroundColor: colorMap.training,
      },
    ];

    // Tryout Dates
    const tryoutDates = [
      {
        title: 'Spring Tryouts',
        date: `${currentYear}-03-01`,
        endDate: `${currentYear}-03-03`,
        category: 'tryout',
        backgroundColor: colorMap.tryout,
      },
      {
        title: 'Fall Tryouts',
        date: `${currentYear}-08-15`,
        endDate: `${currentYear}-08-17`,
        category: 'tryout',
        backgroundColor: colorMap.tryout,
      },
    ];

    // School Breaks (approximate)
    const schoolBreaks = [
      {
        title: 'Spring Break',
        date: `${currentYear}-03-14`,
        endDate: `${currentYear}-03-21`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
      },
      {
        title: 'Summer Break',
        date: `${currentYear}-06-10`,
        endDate: `${currentYear}-08-20`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
      },
      {
        title: 'Winter Break',
        date: `${currentYear}-12-20`,
        endDate: `${currentYear + 1}-01-04`,
        category: 'holidays',
        backgroundColor: colorMap.holidays,
      },
    ];

    // Combine all dates
    return [...holidays, ...seasonMilestones, ...tryoutDates, ...schoolBreaks];
  }

  // Helper methods to calculate floating holidays
  getMLKDay(year) {
    // Third Monday of January
    const jan = new Date(year, 0, 1);
    let day = jan.getDay();
    let offset = day <= 1 ? 1 - day : 8 - day;
    offset += 14; // Third week
    return `${year}-01-${String(offset + 1).padStart(2, '0')}`;
  }

  getPresidentsDay(year) {
    // Third Monday of February
    const feb = new Date(year, 1, 1);
    let day = feb.getDay();
    let offset = day <= 1 ? 1 - day : 8 - day;
    offset += 14; // Third week
    return `${year}-02-${String(offset + 1).padStart(2, '0')}`;
  }

  getMemorialDay(year) {
    // Last Monday of May
    const may = new Date(year, 4, 31);
    let day = may.getDay();
    let offset = day === 1 ? 0 : day === 0 ? 6 : day - 1;
    return `${year}-05-${String(31 - offset).padStart(2, '0')}`;
  }

  getLaborDay(year) {
    // First Monday of September
    const sep = new Date(year, 8, 1);
    let day = sep.getDay();
    let offset = day <= 1 ? 1 - day : 8 - day;
    return `${year}-09-${String(offset + 1).padStart(2, '0')}`;
  }

  getColumbusDay(year) {
    // Second Monday of October
    const oct = new Date(year, 9, 1);
    let day = oct.getDay();
    let offset = day <= 1 ? 1 - day : 8 - day;
    offset += 7; // Second week
    return `${year}-10-${String(offset + 1).padStart(2, '0')}`;
  }

  getThanksgiving(year) {
    // Fourth Thursday of November
    const nov = new Date(year, 10, 1);
    let day = nov.getDay();
    let offset = day <= 4 ? 4 - day : 11 - day;
    offset += 21; // Fourth week
    return `${year}-11-${String(offset + 1).padStart(2, '0')}`;
  }
}

module.exports = CalendarDateGenerator;
