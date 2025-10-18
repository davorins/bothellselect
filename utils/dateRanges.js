const getDateRange = (range) => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0 = January, 1 = February, etc.

  let start = new Date();
  let end = new Date();

  switch (range) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case 'yesterday':
      start.setDate(now.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(now.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case 'this-week':
      // Start of week (Sunday)
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case 'last-week':
      // Start of last week (previous Sunday)
      start.setDate(now.getDate() - now.getDay() - 7);
      start.setHours(0, 0, 0, 0);
      // End of last week (previous Saturday)
      end.setDate(now.getDate() - now.getDay() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case 'this-month':
      // Start of current month (1st day)
      start = new Date(currentYear, currentMonth, 1);
      start.setHours(0, 0, 0, 0);
      // End of current month (last day)
      end = new Date(currentYear, currentMonth + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case 'last-month':
      // Start of previous month (1st day)
      const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
      start = new Date(prevYear, prevMonth, 1);
      start.setHours(0, 0, 0, 0);
      // End of previous month (last day)
      end = new Date(prevYear, prevMonth + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case 'this-year':
      start = new Date(currentYear, 0, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date(currentYear, 11, 31);
      end.setHours(23, 59, 59, 999);
      break;
    case 'last-year':
      start = new Date(currentYear - 1, 0, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date(currentYear - 1, 11, 31);
      end.setHours(23, 59, 59, 999);
      break;
    default:
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
  }

  console.log(`📅 Date range for ${range}:`, {
    start: start.toISOString(),
    end: end.toISOString(),
    startLocal: start.toLocaleDateString(),
    endLocal: end.toLocaleDateString(),
    currentYear: currentYear,
    currentMonth: currentMonth,
  });

  return { start, end };
};

module.exports = { getDateRange };
