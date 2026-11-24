import '@testing-library/jest-dom/vitest'

// Server-rendering specs run in the Node environment, where the browser test
// platform cannot be initialized. Client specs keep the existing TestBed setup.
if (typeof window !== 'undefined') {
  const { getTestBed } = await import('@angular/core/testing')
  const { BrowserTestingModule, platformBrowserTesting } =
    await import('@angular/platform-browser/testing')

  getTestBed().initTestEnvironment(
    BrowserTestingModule,
    platformBrowserTesting(),
  )
}
