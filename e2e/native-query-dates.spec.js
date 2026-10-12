const {test: base, expect} = require('@playwright/test');
const test = base.extend({request: async ({context}, use) => use(context.request)});
const PREFIX = '/api/v1/plugins/assisted-dialin.reaplugin';
const cases = [
  {zone:'UTC', captured:'2026-10-11T08:00:42.123+05:30', sample:'2026-10-11T02:29:11.125678Z', localCaptured:'2026-10-11T02:30:42.123', localSample:'2026-10-11T02:29:11.125', editedCaptured:'2026-10-11T02:30:42.123Z', editedSample:'2026-10-11T02:29:11.125Z'},
  {zone:'Europe/Berlin', captured:'2026-10-25T01:30:12.345Z', sample:'2026-10-25T02:29:11.125+01:00', localCaptured:'2026-10-25T02:30:12.345', localSample:'2026-10-25T02:29:11.125', editedCaptured:'2026-10-25T00:30:12.345Z', editedSample:'2026-10-25T00:29:11.125Z'},
  {zone:'America/New_York', captured:'2026-11-01T01:30:12.345-05:00', sample:'2026-11-01T06:29:11.125Z', localCaptured:'2026-11-01T01:30:12.345', localSample:'2026-11-01T01:29:11.125', editedCaptured:'2026-11-01T05:30:12.345Z', editedSample:'2026-11-01T05:29:11.125Z'},
];

for (const values of cases) test.describe(values.zone, () => {
  test.use({timezoneId:values.zone});
  test('launch instants display locally and survive confirmed feedback until their fields are edited', async ({page, request}) => {
    await request.post('/__test/reset');
    const query = new URLSearchParams({action:'feedback',shotId:'shot-1',beanScaleId:'aux-scale-1',beanWeight:'18.4',beanCapturedAt:values.captured,beanSampleTimestamp:values.sample});
    await page.goto(PREFIX + '/ui?' + query);
    await page.locator('nav button[data-native-step="3"]').click();
    const form = page.locator('#feedback');
    await form.getByText('Optional bean weighing record',{exact:true}).click();
    const captured = form.locator('[name=beanCapturedAt]'), sample = form.locator('[name=beanSampleTimestamp]');
    await expect(captured).toHaveAttribute('type','datetime-local');
    await expect(sample).toHaveAttribute('type','datetime-local');
    await expect(captured).toHaveValue(values.localCaptured);
    await expect(sample).toHaveValue(values.localSample);
    const confirmation = form.locator('[name=confirmBeanMeasurement]');
    await expect(confirmation).not.toBeChecked();
    const submit = async () => {
      const received = page.waitForResponse(response => new URL(response.url()).pathname === PREFIX + '/feedback' && response.request().method() === 'POST');
      await form.getByRole('button',{name:'Mark good',exact:true}).click();
      const response = await received;
      expect(response.ok()).toBe(true);
      await expect(page.locator('#result')).toContainText('Feedback saved');
      return response.request().postDataJSON();
    };
    expect(await submit()).not.toHaveProperty('measuredBeanDose');
    await confirmation.check();
    let record = (await submit()).measuredBeanDose;
    expect(record).toMatchObject({capturedAt:values.captured,sampleTimestamp:values.sample,weightG:18.4,userConfirmed:true});
    await request.post('/__test/reload');
    const analysis = await request.post(PREFIX + '/analysis',{data:{shotId:'shot-1'}});
    expect((await analysis.json()).measuredBeanDose).toMatchObject({capturedAt:values.captured,sampleTimestamp:values.sample});

    // An owner edit, even back to the displayed time, removes that field's original-instant hint.
    await captured.fill('2026-10-12T12:00:00.123'); await captured.fill(values.localCaptured);
    record = (await submit()).measuredBeanDose;
    expect(record.capturedAt).toBe(values.editedCaptured);
    expect(record.sampleTimestamp).toBe(values.sample);
    await sample.fill('2026-10-12T12:00:00.125'); await sample.fill(values.localSample);
    record = (await submit()).measuredBeanDose;
    expect(record.capturedAt).toBe(values.editedCaptured);
    expect(record.sampleTimestamp).toBe(values.editedSample);
  });
});
