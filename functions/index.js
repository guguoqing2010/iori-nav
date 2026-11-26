// functions/index.js
import { isAdminAuthenticated, getHomeCacheKey, clearHomeCacheDirtyIfValue, markHomeCacheDirty, getHomeCacheDirtyValue, getGraphCacheGeneration, writeHomeCacheIfUnchanged } from './_middleware';
import { FONT_MAP } from './constants';
import { escapeHTML, sanitizeUrl, normalizeSortOrder, getStyleStr, sanitizeStyleColor } from './lib/utils';
import { getSettingsKeys, parseSettings } from './lib/settings-parser';
import { renderHorizontalMenu, renderVerticalMenu } from './lib/menu-renderer';
import { renderSiteCards, renderEmptyState } from './lib/card-renderer';
import { buildCardHydrationState } from './lib/card-model';
import { ensureSchemaReady } from './lib/schema-migration';
import { resolveWallpaperUrl } from './lib/wallpaper-defaults';

let cachedTemplateHtml = null;
async function getTemplateHtml(env, requestUrl) {
  if (cachedTemplateHtml !== null) return cachedTemplateHtml;
  const res = await env.ASSETS.fetch(new URL('/index.html', requestUrl));
  cachedTemplateHtml = await res.text();
  return cachedTemplateHtml;
}

function getThemeClasses(isCustomWallpaper) {
  return isCustomWallpaper ? {
    headerClass: 'bg-transparent border-none shadow-none transition-colors duration-300',
    containerClass: '',
    titleColorClass: 'text-gray-900 dark:text-gray-100',
    subTextColorClass: 'text-gray-600 dark:text-gray-300',
    searchInputClass: 'bg-white/90 backdrop-blur border border-gray-200 text-gray-800 placeholder-gray-400 focus:ring-primary-200 focus:border-primary-400 focus:bg-white dark:bg-gray-800/90 dark:border-gray-600 dark:text-gray-200 dark:focus:bg-gray-800',
    searchIconClass: 'text-gray-400 dark:text-gray-500',
  } : {
    headerClass: 'bg-primary-700 text-white border-b border-primary-600 shadow-sm dark:bg-gray-900 dark:border-gray-800',
    containerClass: '',
    titleColorClass: 'text-white',
    subTextColorClass: 'text-primary-100/90 dark:text-gray-400',
    searchInputClass: 'bg-white/15 text-white placeholder-primary-200 focus:ring-white/30 focus:bg-white/20 border-none dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder-gray-500',
    searchIconClass: 'text-primary-200 dark:text-gray-500',
  };
}

function normalizeCssPixelValue(value, fallback) {
  const normalized = String(value ?? '').trim().replace(/[^0-9]/g, '');
  if (normalized === '') return String(fallback);
  return normalized;
}

export async function onRequest(context) {
  const { request, env } = context;

  const isAuthenticated = await isAdminAuthenticated(request, env);
  const includePrivate = isAuthenticated ? 1 : 0;

  // === 1. 缓存检查 ===
  const url = new URL(request.url);
  const isHomePage = url.pathname === '/' && !url.search;
  const cacheScope = isAuthenticated ? 'private' : 'public';
  const cookies = request.headers.get('Cookie') || '';
  const hasLegacyStaleCookie = cookies.includes('iori_cache_stale=1');
  const hasPublicStaleCookie = hasLegacyStaleCookie || cookies.includes('iori_cache_public_stale=1');
  const hasPrivateStaleCookie = hasLegacyStaleCookie || cookies.includes('iori_cache_private_stale=1');
  let shouldClearCookie = false;
  let cacheDirty = false;
  let cacheDirtyValue = null;
  let cacheGeneration = null;

  if (isHomePage) {
    if (isAuthenticated && (hasPublicStaleCookie || hasPrivateStaleCookie)) {
      if (hasPublicStaleCookie && hasPrivateStaleCookie) {
        await markHomeCacheDirty(env, 'all');
      } else if (hasPublicStaleCookie) {
        await markHomeCacheDirty(env, 'public');
      } else {
        await markHomeCacheDirty(env, 'private');
      }
      shouldClearCookie = true;
    }

    let cachedHtml = null;
    try {
      [cacheDirtyValue, cacheGeneration] = await Promise.all([
        getHomeCacheDirtyValue(env, cacheScope),
        ensureSchemaReady(env).then(() => getGraphCacheGeneration(env)),
      ]);
      if (cacheGeneration !== null) {
        cachedHtml = await env.NAV_AUTH.get(getHomeCacheKey(cacheScope, cacheGeneration));
      }
    } catch (e) {
      console.warn('Failed to read home cache:', e);
      cachedHtml = null;
      cacheDirtyValue = null;
      cacheGeneration = null;
    }
    cacheDirty = !!cacheDirtyValue;

    if (!cacheDirty && cachedHtml) {
      const response = new Response(cachedHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': isAuthenticated ? 'private, no-store, max-age=0' : 'public, max-age=0, must-revalidate',
          'X-Cache': 'HIT',
        }
      });

      if (shouldClearCookie) {
        response.headers.append('Set-Cookie', 'iori_cache_stale=; Path=/; Max-Age=0; SameSite=Lax');
        response.headers.append('Set-Cookie', 'iori_cache_public_stale=; Path=/; Max-Age=0; SameSite=Lax');
        response.headers.append('Set-Cookie', 'iori_cache_private_stale=; Path=/; Max-Age=0; SameSite=Lax');
      }

      return response;
    }
  }

  // === 2. 并行执行数据库查询 + 模板获取 ===
  const categoryQuery = isAuthenticated
    ? 'SELECT id, catelog, sort_order, parent_id, is_private FROM category ORDER BY sort_order ASC, id ASC'
    : 'SELECT id, catelog, sort_order, parent_id FROM category WHERE is_private = 0 ORDER BY sort_order ASC, id ASC';

  const settingsKeys = getSettingsKeys();
  const settingsPlaceholders = settingsKeys.map(() => '?').join(',');
  const sitesQuery = `SELECT id, name, url, logo, desc, catelog_id, catelog_name
                      FROM sites WHERE (is_private = 0 OR ? = 1) ORDER BY sort_order ASC, create_time DESC`;

  const settingsCacheKey = 'settings_cache';
  const fetchSettings = async () => {
    try {
      const cached = await env.NAV_AUTH.get(settingsCacheKey, { type: 'json' });
      if (cached) return { results: cached, fromCache: true };
    } catch (e) {
      console.warn('Settings cache read failed:', e);
    }
    const result = await env.NAV_DB.prepare(`SELECT key, value FROM settings WHERE key IN (${settingsPlaceholders})`).bind(...settingsKeys).all();
    if (result.results && env.NAV_AUTH) {
      context.waitUntil(env.NAV_AUTH.put(settingsCacheKey, JSON.stringify(result.results), { expirationTtl: 86400 }));
    }
    return result;
  };

  const [categoriesResult, settingsResult, sitesResult, templateHtml] = await Promise.all([
    env.NAV_DB.prepare(categoryQuery).all().catch(e => ({ results: [], error: e })),
    fetchSettings().catch(e => ({ results: [], error: e })),
    env.NAV_DB.prepare(sitesQuery).bind(includePrivate).all().catch(e => ({ results: [], error: e })),
    getTemplateHtml(env, request.url)
  ]);

  // === 3. 处理分类结果 — 构建分类树 ===
  let categories = categoriesResult.results || [];
  if (categoriesResult.error) console.error('Failed to fetch categories:', categoriesResult.error);

  const categoryMap = new Map();
  const categoryIdMap = new Map();
  const rootCategories = [];

  categories.forEach(cat => {
    cat.children = [];
    cat.sort_order = normalizeSortOrder(cat.sort_order);
    categoryMap.set(cat.id, cat);
    if (cat.catelog) categoryIdMap.set(cat.catelog, cat.id);
  });

  categories.forEach(cat => {
    if (cat.parent_id && categoryMap.has(cat.parent_id)) {
      categoryMap.get(cat.parent_id).children.push(cat);
    } else {
      rootCategories.push(cat);
    }
  });

  const sortCats = (cats) => {
    cats.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    cats.forEach(c => sortCats(c.children));
  };
  sortCats(rootCategories);

  // === 4. 解析设置 ===
  const S = parseSettings(settingsResult.results || settingsResult);

  // === 5. 处理站点结果 ===
  let allSites = sitesResult.results || [];
  if (sitesResult.error) return new Response(`Failed to fetch sites: ${sitesResult.error.message}`, { status: 500 });

  function resolveCatalogId(catalogValue, options = {}) {
    const value = String(catalogValue || '').trim();
    if (!value || value.toLowerCase() === 'all') return null;
    if (/^\d+$/.test(value)) {
      const id = Number(value);
      if (categoryMap.has(id)) return id;
    }
    return options.allowName && categoryIdMap.has(value) ? categoryIdMap.get(value) : null;
  }

  // === 6. 确定目标分类 ===
  const requestedCatalogValue = (url.searchParams.get('catalog') || '').trim();
  let requestedCatalogId = resolveCatalogId(requestedCatalogValue);

  if (!requestedCatalogValue) {
    const defaultCat = (S.home_default_category || '').trim();
    requestedCatalogId = resolveCatalogId(defaultCat, { allowName: true });
  }

  let targetCategoryIds = [];
  let currentCatalogName = '';
  const catalogExists = requestedCatalogId !== null;

  if (catalogExists) {
    const requestedCategory = categoryMap.get(requestedCatalogId);
    currentCatalogName = requestedCategory.catelog;
    targetCategoryIds.push(requestedCatalogId);
  }

  const sites = targetCategoryIds.length > 0
    ? allSites.filter(site => targetCategoryIds.includes(site.catelog_id))
    : allSites;

  // === 7. 壁纸处理 ===
  const resolvedWallpaperUrl = resolveWallpaperUrl(S.layout_custom_wallpaper, S.layout_card_style);
  const isCustomWallpaper = Boolean(resolvedWallpaperUrl);
  const themeClass = isCustomWallpaper ? 'custom-wallpaper' : '';

  // === 8. 计算主题样式 ===
  const themeClasses = getThemeClasses(isCustomWallpaper);
  const { headerClass, containerClass, titleColorClass, subTextColorClass, searchInputClass, searchIconClass } = themeClasses;

  // === 9. 生成菜单 HTML ===
  const allLinkActive = !catalogExists;
  const allLinkClass = allLinkActive ? 'active' : 'inactive';
  const allLinkActiveMarker = allLinkActive ? 'nav-item-active' : '';
  const horizontalAllLink = `
    <div class="menu-item-wrapper relative inline-block text-left">
      <a href="?catalog=all" class="nav-btn ${allLinkClass}${allLinkActiveMarker}">全部</a>
    </div>`;
  const horizontalCatalogMarkup = horizontalAllLink + renderHorizontalMenu(rootCategories, currentCatalogName);
  const catalogLinkMarkup = renderVerticalMenu(rootCategories, currentCatalogName, isCustomWallpaper);

  // === 10. 生成站点卡片 HTML ===
  let sitesGridMarkup = sites.length > 0
    ? renderSiteCards(sites, S)
    : renderEmptyState(categories.length, S.home_hide_admin);

  // === 11. 计算 Grid 列数 ===
  const getMobileGridClass = (cols) => {
    if (cols === '1') return 'grid-cols-1';
    if (cols === '3') return 'grid-cols-3';
    return 'grid-cols-4';
  };
  const getDesktopGridClass = (cols) => {
    if (cols === '5') return 'md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12';
    if (cols === '6') return 'md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-11 2xl:grid-cols-12';
    if (cols === '7') return 'md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 2xl:grid-cols-14';
    if (cols === '8') return 'md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12 2xl:grid-cols-14';
    return 'md:grid-cols-7 lg:grid-cols-9 xl:grid-cols-11';
  };
  const getCardStyleGridClass = (style, prefix) => {
    if (style === 'style3') return `${prefix}-card-style3`;
    return style === 'style2' ? `${prefix}-card-style2` : `${prefix}-card-style1`;
  };
  const mobileCardStyleClass = getCardStyleGridClass(S.mobile_layout_card_style, 'mobile');
  const desktopCardStyleClass = getCardStyleGridClass(S.layout_card_style, 'desktop');
  let gridClass = `grid w-full ${getMobileGridClass(S.mobile_layout_grid_cols)} ${getDesktopGridClass(S.layout_grid_cols)}${mobileCardStyleClass} ${desktopCardStyleClass} gap-2.5 sm:gap-3 justify-items-stretch`;  // === 12. 计算文本和统计信息 === const headingPlainText = currentCatalogName ? `${currentCatalogName} · ${sites.length} 个书签` : `全部收藏 · ${sites.length} 个书签`;
  const headingText = escapeHTML(headingPlainText);
  const headingDefaultAttr = escapeHTML(headingPlainText);
  const headingActiveAttr = catalogExists ? escapeHTML(currentCatalogName) : '';
  const submissionEnabled = String(env.ENABLE_PUBLIC_SUBMISSION) === 'true';
  const submissionClass = submissionEnabled ? '' : '!hidden';
  const siteName = S.home_site_name || env.SITE_NAME || '灰色轨迹';
  const siteDescription = S.home_site_description || env.SITE_DESCRIPTION || '一个优雅、快速、易于部署的书签（网址）收藏与分享平台，完全基于 Cloudflare 全家桶构建';
  const footerText = S.home_footer_text || env.FOOTER_TEXT || '曾梦想仗剑走天涯';
  const titleStyle = getStyleStr(S.home_title_size, S.home_title_color, S.home_title_font);
  const subtitleStyle = getStyleStr(S.home_subtitle_size, S.home_subtitle_color, S.home_subtitle_font);
  const statsStyle = getStyleStr(S.home_stats_size, S.home_stats_color, S.home_stats_font);
  const hitokotoStyle = getStyleStr(S.home_hitokoto_size, S.home_hitokoto_color, S.home_hitokoto_font);
  const hitokotoContent = S.home_hide_hitokoto ? '' : '疏影横斜水清浅,暗香浮动月黄昏。';
  const shouldRenderStatsRow = !S.home_hide_stats || !S.home_hide_hitokoto;
  const statsRowPyClass = shouldRenderStatsRow ? 'my-4' : 'hidden';
  const statsRowHiddenClass = shouldRenderStatsRow ? '' : 'hidden';

  // === 13. 搜索引擎选项 ===
  const searchEngineOptions = S.home_search_engine_enabled ? `
    <div class="flex justify-center items-center gap-3 mb-4 text-sm select-none search-engine-wrapper">
        <label class="search-engine-option active" data-engine="local"><span>站内</span></label>
        <label class="search-engine-option" data-engine="google"><span>Google</span></label>
        <label class="search-engine-option" data-engine="baidu"><span>Baidu</span></label>
        <label class="search-engine-option" data-engine="github"><span>Github</span></label>
    </div>` : '';

  // === 14. Header HTML ===
  const safeSiteName = escapeHTML(siteName);
  const safeSiteDesc = escapeHTML(siteDescription);
  const horizontalTitleHtml = S.layout_hide_title ? '' : `<h1 class="text-3xl md:text-4xl font-bold tracking-tight mb-3 ${titleColorClass}" ${titleStyle}>${safeSiteName}</h1>`;
  const horizontalSubtitleHtml = S.layout_hide_subtitle ? '' : `<p class="${subTextColorClass} opacity-90 text-sm md:text-base" ${subtitleStyle}>${safeSiteDesc}</p>`;
  const categoryPosition = S.home_category_position;
  const isHorizontalCategoryLayout = categoryPosition !== 'left';
  const categoryFlow = S.home_category_flow === 'multi_line' ? 'multi_line' : 'single_line';
  const horizontalCategoryNavShellClass = categoryPosition === 'top'
    ? 'horizontal-category-nav-shell is-top relative mx-auto'
    : 'horizontal-category-nav-shell relative mx-auto';
  const horizontalCategoryNavJustifyClass = categoryFlow === 'multi_line' ? 'justify-start' : 'justify-center';
  const horizontalCategoryNavWrapClass = categoryFlow === 'multi_line' ? 'flex-wrap' : 'flex-nowrap';
  const horizontalCategoryNavOverflowClass = 'overflow-visible';
  const horizontalCategoryNavFlowClass = categoryFlow === 'multi_line' ? 'is-multi-line' : 'is-single-line';
  const horizontalMoreHtml = categoryFlow === 'multi_line' ? '' : `
          <div id="horizontalMoreWrapper" class="relative hidden">
            <button id="horizontalMoreBtn" class="nav-btn inactive">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" /></svg>
            </button>
            <div id="horizontalMoreDropdown" class="dropdown-menu hidden absolute mt-2 w-auto z-50"></div>
          </div>`;

  const horizontalCategoryNavHtml = `
      <div class="${horizontalCategoryNavShellClass}">
        <div id="horizontalCategoryNav" class="flex ${horizontalCategoryNavWrapClass}${horizontalCategoryNavJustifyClass} items-center gap-3 ${horizontalCategoryNavOverflowClass}${horizontalCategoryNavFlowClass} transition-all duration-300">
          ${horizontalCatalogMarkup}${horizontalMoreHtml}
        </div>
      </div>`;

  const verticalHeaderContent = `
    <div class="max-w-4xl mx-auto text-center relative z-10 ${themeClass} py-8">
      <div class="home-title-block mb-8">${horizontalTitleHtml}${horizontalSubtitleHtml}</div>
      <div class="home-search-shell relative max-w-xl mx-auto">
        ${searchEngineOptions}
        <div class="home-search-field relative">
          <input type="search" placeholder="搜索书签..." class="search-input-target w-full pl-12 pr-4 py-3.5 rounded-2xl transition-all shadow-lg outline-none focus:outline-none focus:ring-2 ${searchInputClass}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="search" enterkeyhint="search" aria-label="搜索书签" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">
          <svg xmlns="http://www.w3.org/2000/svg" class="home-search-icon h-6 w-6 absolute left-4 top-3.5 ${searchIconClass}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        </div>
      </div>
    </div>`;

  const horizontalHeaderContent = `
    <div class="max-w-5xl mx-auto text-center relative z-10 ${themeClass}">
      ${categoryPosition === 'top' ? `<div class="category-nav-top-wrap">${horizontalCategoryNavHtml}</div>` : ''}
      <div class="home-title-block max-w-4xl mx-auto mb-8">${horizontalTitleHtml}${horizontalSubtitleHtml}</div>${categoryPosition === 'above_search' ? `<div class="mb-6">${horizontalCategoryNavHtml}</div>` : ''}
      <div class="home-search-shell relative max-w-xl mx-auto ${categoryPosition === 'below_search' ? 'mb-6' : ''}">
        ${searchEngineOptions}
        <div class="home-search-field relative">
          <input id="headerSearchInput" type="search" placeholder="搜索书签..." class="search-input-target w-full pl-12 pr-4 py-3.5 rounded-2xl transition-all shadow-lg outline-none focus:outline-none focus:ring-2 ${searchInputClass}" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="search" enterkeyhint="search" aria-label="搜索书签" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">
          <svg xmlns="http://www.w3.org/2000/svg" class="home-search-icon h-6 w-6 absolute left-4 top-3.5 ${searchIconClass}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        </div>
      </div>
      ${categoryPosition === 'below_search' ? horizontalCategoryNavHtml : ''}
    </div>`;

  // === 15. 布局控制 ===
  let sidebarClass = '';
  let mainClass = 'lg:ml-64';
  let sidebarToggleClass = '';
  let mobileToggleVisibilityClass = 'lg:hidden';
  let adminIconHtml = '';
  const themeIconHtml = `
    <button id="themeToggleBtn" class="top-action-icon theme-action-icon" title="切换主题">
      <svg id="themeIconSun" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="block dark:hidden"><circle cx="12" cy="12" r="5"></circle><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path></svg>
      <svg id="themeIconMoon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden dark:block"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
    </button>`;

  let headerContent = verticalHeaderContent;

  if (isHorizontalCategoryLayout) {
    sidebarClass = 'min-[550px]:hidden';
    mainClass = '';
    sidebarToggleClass = '!hidden';
    mobileToggleVisibilityClass = 'min-[550px]:hidden';

    if (!S.home_hide_admin) {
      adminIconHtml = `
        <a href="/admin" target="_blank" class="top-action-icon admin-action-icon" title="后台管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M7 18a5 5 0 0 1 10 0"/></svg>
        </a>`;
    }

    headerContent = `
      <div class="min-[550px]:hidden">${verticalHeaderContent}</div>
      <div class="hidden min-[550px]:block">${horizontalHeaderContent}</div>`;
  }

  const topRightActionsHtml = `<div class="fixed top-4 right-4 z-50 flex items-center gap-3">${themeIconHtml}${adminIconHtml}</div>`;
  const leftTopActionHtml = `
    <div class="fixed top-4 left-4 z-50 ${mobileToggleVisibilityClass}">
      <button id="sidebarToggle" class="p-2 rounded-lg bg-white dark:bg-gray-800 shadow-md hover:bg-gray-100 dark:hover:bg-gray-700">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-primary-500 dark:text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
    </div>`;

  const footerClass = isCustomWallpaper
    ? 'bg-transparent py-8 px-6 mt-12 border-none shadow-none'
    : 'bg-white py-8 px-6 mt-12 border-t border-primary-100 dark:bg-gray-900 dark:border-gray-800';
  const hitokotoClass = (isCustomWallpaper ? 'text-black dark:text-gray-200' : 'text-gray-500 dark:text-gray-400') + ' ml-auto';

  // === 16. 模板注入 ===
  let html = templateHtml;

  let headInjections = '';

  if (S.home_hide_admin) {
    headInjections += '<style>a[href^="/admin"] { display: none !important; }</style>';
  }

  const safeWallpaperUrl = sanitizeUrl(resolvedWallpaperUrl);
  const defaultBgColor = '#fdf8f3';
  let bgLayerHtml = '';
  if (safeWallpaperUrl) {
    const blurStyle = S.layout_enable_bg_blur ? `filter: blur(${S.layout_bg_blur_intensity}px); transform: scale(1.02);` : '';
    bgLayerHtml = `<div id="fixed-background" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -9999; pointer-events: none; overflow: hidden;"><img src="${safeWallpaperUrl}" alt="" fetchpriority="high" style="width: 100\%; height: 100\%; object-fit: cover; ${blurStyle}" /></div>`;
  } else {
    bgLayerHtml = `<div id="fixed-background" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -9999; pointer-events: none; background-color: ${defaultBgColor};"></div>`;
  }

  if (safeWallpaperUrl) {
    headInjections += `<link rel="preload" as="image" href="${safeWallpaperUrl}">\n`;
  }

  // 去掉外层大格子 + 扁平方格高透明小格 + 窄两边留白 + 侧边栏缩放/自由拖放样式
  headInjections += `<style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    #app-scroll { width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; }
    body { background-color: transparent !important; }
    #fixed-background { transition: background-color 0.3s ease, filter 0.3s ease; }
    @supports (-webkit-touch-callout: none) { #fixed-background { height: -webkit-fill-available; } }

    .home-stats-row,
    section:has(#sitesGrid) {
      max-width: 100% !important;
      width: 100% !important;
      padding-left: 10px !important;
      padding-right: 10px !important;
    }

    /* 彻底去掉包裹书签网格的大格子 */
    section:has(#sitesGrid) > div {
      width: 100% !important;
      max-width: 100% !important;
      background: transparent !important;
      background-color: transparent !important;
      border: none !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      border-radius: 0 !important;
      padding: 4px 0 !important;
    }

    /* 侧边栏菜单内的标签缩放与自由拖放工具栏 */
    .iori-sidebar-tools {
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid rgba(156, 163, 175, 0.25);
      font-size: 0.875rem;
    }
    .iori-sidebar-tool-btn {
      width: 100%;
      padding: 0.45rem 0.65rem;
      border-radius: 0.5rem;
      border: 1px solid rgba(156, 163, 175, 0.35);
      background: rgba(255, 255, 255, 0.12);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: all 0.15s ease;
    }
    .iori-sidebar-tool-btn:hover {
      background: rgba(255, 255, 255, 0.22);
    }
    .iori-sidebar-tool-btn.is-active {
      background: rgba(59, 130, 246, 0.22);
      border-color: rgba(59, 130, 246, 0.7);
      font-weight: 600;
    }

    /* 单个书签小格：扁平化方格 + 高透明度 */
    #sitesGrid .site-card,
    #sitesGrid > a,
    #sitesGrid > div {
      background-color: rgba(255, 255