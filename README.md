# Under the Table

Gum reports from restaurant tables, by The Gum Inspector.

## How it works

- Each report is a small text file in `content/reports/`.
- Posting happens at **https://app.pagescms.org**, a simple form that saves the report here.
- Every save runs the **Publish site** action. It builds the pages, shrinks photos, strips their location data and publishes to GitHub Pages. The site updates in about a minute.

Each report gets its own address, like `/reports/dok-mali-thai-portland-me/`, with its own title, description and share image, so search engines can list it.

## One-time setup (for a grown-up)

1. **Put these files in a GitHub repository.** Make it public and name it something like `under-the-table`.
2. **Turn on Pages.** In the repository go to **Settings → Pages**. Under "Build and deployment", set **Source** to **GitHub Actions**.
3. **Run the first publish.** Go to **Actions → Publish site → Run workflow**. When it finishes (green check), the site is live at `https://YOUR-USERNAME.github.io/under-the-table/`. Links fully work once the custom domain in step 4 is connected.
4. **Connect your domain.**
   - In **Settings → Pages → Custom domain**, type your domain (for example `gumreport.com`) and save.
   - At the company where you bought the domain, add these DNS records:
     - Four **A** records for `@` pointing to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153`
     - One **CNAME** record for `www` pointing to `YOUR-USERNAME.github.io`
   - DNS can take up to a few hours. Then tick **Enforce HTTPS** in Settings → Pages.
5. **Tell the site its address.** In Pages CMS open **Site settings** and set **Website address** to `https://yourdomain.com`. Or edit `content/site.yml` on GitHub.
6. **Set up posting.** Go to https://app.pagescms.org, sign in with GitHub and install the Pages CMS app on this repository only. Open the repository, and **Gum reports → Add an entry** is the posting form.
7. **Tell Google about it (optional, helps search).** Add your domain at https://search.google.com/search-console and submit `https://yourdomain.com/sitemap.xml`.

## Posting a report

1. Open https://app.pagescms.org and pick the repository.
2. Choose **Gum reports → Add an entry**.
3. Fill in the restaurant, town, state, date, gum count, colors, tables checked, "Would you go back?", the write-up and an optional photo.
4. Press **Save**. The site updates in about a minute.

To fix or remove a report, open it in the same list and edit or delete it.

## Notes

- Photos are shrunk and their location data is removed on the website. The original upload stays in this public repository with its data, so it's best to turn off location for the camera or take the photo with location off.
- Use a pen name, never a real name.
- To build locally: `node build.mjs` (Node 18+, no installs needed). The output goes to `_site/`.
