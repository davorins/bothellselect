// backend/seeders/formFieldConfigSeeder.js
const FormFieldConfig = require('../models/FormFieldConfig');

const defaultFieldConfigs = [
  // Player fields - ALL ENABLED BY DEFAULT
  {
    fieldName: 'fullName',
    label: 'Full Name',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 1,
    section: 'personal',
    appliesTo: ['player'],
    validation: { minLength: 2, maxLength: 100 },
  },
  {
    fieldName: 'gender',
    label: 'Gender',
    fieldType: 'select',
    isEnabled: true,
    isRequired: true,
    displayOrder: 2,
    section: 'personal',
    appliesTo: ['player'],
    options: [
      { value: 'Male', label: 'Male' },
      { value: 'Female', label: 'Female' },
    ],
  },
  {
    fieldName: 'dob',
    label: 'Date of Birth',
    fieldType: 'date',
    isEnabled: true,
    isRequired: true,
    displayOrder: 3,
    section: 'personal',
    appliesTo: ['player'],
    calculation: {
      type: 'fromDOB',
      dependsOn: ['dob'],
    },
  },
  {
    fieldName: 'age',
    label: 'Age',
    fieldType: 'number',
    isEnabled: true,
    isRequired: false,
    isReadOnly: true,
    displayOrder: 4,
    section: 'personal',
    appliesTo: ['player'],
    calculation: {
      type: 'fromDOB',
      dependsOn: ['dob'],
    },
    dependencies: [{ field: 'dob', operator: 'exists', value: null }],
  },
  {
    fieldName: 'schoolName',
    label: 'School Name',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 5,
    section: 'personal',
    appliesTo: ['player'],
  },
  {
    fieldName: 'grade',
    label: 'Grade',
    fieldType: 'select',
    isEnabled: true,
    isRequired: true,
    displayOrder: 6,
    section: 'personal',
    appliesTo: ['player'],
    allowOverride: true,
    options: [
      { value: 'PK', label: 'Pre-K' },
      { value: 'K', label: 'Kindergarten' },
      ...Array.from({ length: 12 }, (_, i) => ({
        value: (i + 1).toString(),
        label: `${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'} Grade`,
      })),
    ],
    calculation: {
      type: 'fromDOB',
      dependsOn: ['dob'],
    },
  },
  {
    fieldName: 'healthConcerns',
    label: 'Health Concerns',
    fieldType: 'textarea',
    isEnabled: true,
    isRequired: false,
    displayOrder: 7,
    section: 'medical',
    appliesTo: ['player'],
  },
  {
    fieldName: 'aauNumber',
    label: 'AAU Number',
    fieldType: 'text',
    isEnabled: true,
    isRequired: false,
    displayOrder: 8,
    section: 'personal',
    appliesTo: ['player'],
  },

  // Parent/Guardian fields
  {
    fieldName: 'fullName',
    label: 'Full Name',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 1,
    section: 'personal',
    appliesTo: ['parent', 'guardian'],
  },
  {
    fieldName: 'email',
    label: 'Email Address',
    fieldType: 'email',
    isEnabled: true,
    isRequired: true,
    displayOrder: 2,
    section: 'contact',
    appliesTo: ['parent', 'guardian'],
    validation: { pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
  },
  {
    fieldName: 'phone',
    label: 'Phone Number',
    fieldType: 'tel',
    isEnabled: true,
    isRequired: true,
    displayOrder: 3,
    section: 'contact',
    appliesTo: ['parent', 'guardian'],
  },
  {
    fieldName: 'address',
    label: 'Street Address',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 4,
    section: 'contact',
    appliesTo: ['parent', 'guardian'],
  },
  {
    fieldName: 'city',
    label: 'City',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 5,
    section: 'contact',
    appliesTo: ['parent', 'guardian'],
  },
  {
    fieldName: 'state',
    label: 'State',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 6,
    section: 'contact',
    appliesTo: ['parent', 'guardian'],
    validation: { minLength: 2, maxLength: 2 },
  },
  {
    fieldName: 'zip',
    label: 'ZIP Code',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 7,
    section: 'contact',
    appliesTo: ['parent', 'guardian'],
    validation: { pattern: '^\\d{5}(-\\d{4})?$' },
  },
  {
    fieldName: 'relationship',
    label: 'Relationship to Player',
    fieldType: 'select',
    isEnabled: true,
    isRequired: true,
    displayOrder: 8,
    section: 'personal',
    appliesTo: ['parent', 'guardian'],
    options: [
      { value: 'Mother', label: 'Mother' },
      { value: 'Father', label: 'Father' },
      { value: 'Guardian', label: 'Guardian' },
      { value: 'Other', label: 'Other' },
    ],
  },
  {
    fieldName: 'isCoach',
    label: 'Are you a coach?',
    fieldType: 'checkbox',
    isEnabled: true,
    isRequired: false,
    displayOrder: 9,
    section: 'personal',
    appliesTo: ['parent', 'guardian'],
  },

  // Team fields - NEW - Make sure these are properly defined
  {
    fieldName: 'name',
    label: 'Team Name',
    fieldType: 'text',
    isEnabled: true,
    isRequired: true,
    displayOrder: 1,
    section: 'personal',
    appliesTo: ['team'],
    validation: { minLength: 2, maxLength: 100 },
  },
  {
    fieldName: 'grade',
    label: 'Grade',
    fieldType: 'select',
    isEnabled: true,
    isRequired: true,
    displayOrder: 2,
    section: 'personal',
    appliesTo: ['team'],
    options: [
      { value: '3', label: '3rd Grade' },
      { value: '4', label: '4th Grade' },
      { value: '5', label: '5th Grade' },
      { value: '6', label: '6th Grade' },
      { value: '7', label: '7th Grade' },
      { value: '8', label: '8th Grade' },
      { value: '9', label: '9th Grade' },
      { value: '10', label: '10th Grade' },
      { value: '11', label: '11th Grade' },
      { value: '12', label: '12th Grade' },
    ],
  },
  {
    fieldName: 'gender',
    label: 'Gender',
    fieldType: 'select',
    isEnabled: true,
    isRequired: true,
    displayOrder: 3,
    section: 'personal',
    appliesTo: ['team'],
    options: [
      { value: 'Male', label: 'Male' },
      { value: 'Female', label: 'Female' },
    ],
  },
  {
    fieldName: 'year',
    label: 'Year',
    fieldType: 'number',
    isEnabled: true,
    isRequired: true,
    displayOrder: 4,
    section: 'personal',
    appliesTo: ['team'],
    validation: { min: 2020, max: 2030 },
  },
  {
    fieldName: 'tryoutSeason',
    label: 'Tryout Season',
    fieldType: 'text',
    isEnabled: true,
    isRequired: false,
    displayOrder: 5,
    section: 'personal',
    appliesTo: ['team'],
  },
  {
    fieldName: 'coachCount',
    label: 'Coaches',
    fieldType: 'number',
    isEnabled: true,
    isRequired: false,
    isReadOnly: true,
    displayOrder: 6,
    section: 'personal',
    appliesTo: ['team'],
  },
  {
    fieldName: 'playerCount',
    label: 'Players',
    fieldType: 'number',
    isEnabled: true,
    isRequired: false,
    isReadOnly: true,
    displayOrder: 7,
    section: 'personal',
    appliesTo: ['team'],
  },
  {
    fieldName: 'status',
    label: 'Status',
    fieldType: 'select',
    isEnabled: true,
    isRequired: true,
    displayOrder: 8,
    section: 'personal',
    appliesTo: ['team'],
    options: [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
  },
];

const seedFormFieldConfigs = async () => {
  try {
    console.log('🌱 Seeding form field configurations...');

    for (const config of defaultFieldConfigs) {
      // For parent/guardian fullName, we need a unique fieldName
      let fieldName = config.fieldName;

      if (
        config.appliesTo.includes('parent') &&
        config.fieldName === 'fullName'
      ) {
        fieldName = 'parentFullName';
      }

      // For team fields, keep the fieldName as is

      // Log what we're creating
      console.log(
        `Creating/updating field: ${fieldName} for types: ${config.appliesTo.join(', ')}`,
      );

      await FormFieldConfig.findOneAndUpdate(
        { fieldName, appliesTo: config.appliesTo },
        { ...config, fieldName },
        { upsert: true, new: true },
      );
    }

    // Double-check that team fields were created
    const teamFields = await FormFieldConfig.find({ appliesTo: 'team' });
    console.log(
      '✅ Team fields in database:',
      teamFields.map((f) => ({ name: f.fieldName, enabled: f.isEnabled })),
    );

    console.log('✅ Form field configurations seeded successfully');
  } catch (error) {
    console.error('❌ Error seeding form field configurations:', error);
    throw error;
  }
};

module.exports = seedFormFieldConfigs;
