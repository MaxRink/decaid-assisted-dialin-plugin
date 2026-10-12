const {test, expect} = require('@playwright/test');

const assisted = 'MaxRink/decaid-assisted-dialin-plugin';
const destinations = [
  ['My grinder is missing', assisted, 'new-grinder.yml'],
  ['Report a problem', assisted, 'bug-report.yml'],
  ['Suggest an improvement', assisted, 'feature-request.yml'],
  ['Correct a grinder fact or research source', assisted, 'source-correction.yml'],
  ['Correct a coffee catalogue or recipe entry', assisted, 'coffee-catalog-correction.yml'],
  ['Skale connection or scale readings', 'MaxRink/decaid-skale-plugin', 'bug-report.yml'],
  ['E64 WS connection or grinder controls', 'MaxRink/decaid-e64ws-plugin', 'bug-report.yml'],
  ['E64 protocol or research findings', 'MaxRink/mahlkoenig-e64ws-local-research', 'protocol-mock-device.yml'],
  ['Decaid host or saved-shot problems', 'decentespresso/decaid', null],
  ['Streamline navigation or display problems', 'decentespresso/streamline-js', null],
];

test('help routes reach the right issue drafts without sending entered coffee details', async ({page, context}) => {
  await page.goto('/simulator/');
  await page.locator('#bean').fill('Private coffee & name?secret=1');
  await page.locator('#roaster').fill('Private roaster');
  const help = page.getByRole('region', {name:'Help and contribute'});
  await expect(help.getByRole('navigation').getByRole('link')).toHaveCount(3);
  await page.locator('#help-more summary').click();
  for (const [name, repo, template] of destinations) {
    const link = help.getByRole('link', {name, exact:true});
    const destination = new URL(await link.getAttribute('href'));
    expect(destination.origin).toBe('https://github.com');
    expect(destination.pathname).toBe('/' + repo + '/issues/new' + (template ? '' : '/choose'));
    expect([...destination.searchParams.entries()]).toEqual(template ? [['template', template]] : []);
    await expect(link).toHaveAttribute('target','_blank');
    await expect(link).toHaveAttribute('rel','noopener noreferrer');
  }
  // Exercise the contextual link, intercepting the external draft rather than creating an issue.
  await context.route('https://github.com/**', route => route.fulfill({contentType:'text/html',body:'<h1>New grinder issue draft</h1>'}));
  const opened = page.waitForEvent('popup');
  await page.locator('#missing-grinder').click();
  const draft = await opened;
  await expect(draft).toHaveURL('https://github.com/' + assisted + '/issues/new?template=new-grinder.yml');
  await expect(draft.getByRole('heading')).toHaveText('New grinder issue draft');
  await expect(page.locator('#bean')).toHaveValue('Private coffee & name?secret=1');
  await draft.close();
});

test('help stays readable at a narrow mobile width in both modes', async ({page}, info) => {
  await page.setViewportSize({width:320,height:800});
  await page.goto('/simulator/');
  await page.locator('#help-more summary').click();
  for (const mode of ['simple','expert']) {
    await page.locator('#view-mode').selectOption(mode);
    const help = page.getByRole('region',{name:'Help and contribute'});
    await help.scrollIntoViewIfNeeded();
    for (const link of await help.getByRole('link').all()) {
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.screenshot({path:info.outputPath('help-mobile.png'),fullPage:true});
});
