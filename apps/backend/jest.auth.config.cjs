// Focused authentication checks do not depend on the upstream Nx test setup.
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/backend/src/services/auth/**/*.spec.ts'],
  moduleNameMapper: {
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/libraries/nestjs-libraries/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/apps/backend/tsconfig.json',
      isolatedModules: true,
      diagnostics: false,
    }],
  },
};
