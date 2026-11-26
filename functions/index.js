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
  const sitesQuery = 'SELECT id, name, url, logo, desc, catelog_id, catelog_name FROM sites WHERE (is_private = 0 OR ? = 1) ORDER BY sort_order ASC, create_time DESC';

  const settingsCacheKey = 'settings_cache';
  const fetchSettings = async () => {
    try {
      const cached = await env.NAV_AUTH.get(settingsCacheKey, { type: 'json' });
      if (cached) return { results: cached, fromCache: true };
    } catch (e) {
      console.warn('Settings cache read failed:', e);
    }
    const result = await env.NAV_DB.prepare('SELECT key, value FROM settings WHERE key IN (' + settingsPlaceholders + ')').bind(...settingsKeys).all();
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
  if (sitesResult.error) return new Response('Failed to fetch sites: ' + sitesResult.error.message, { status: 500 });

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
  const horizontalAllLink = '<div class="menu-item-wrapper relative inline-block text-left"><a href="?catalog=all" class="nav-btn ' + allLinkClass + ' ' + allLinkActiveMarker + '">全部</a></div>';
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
    if (style === 'style3') return prefix + '-card-style3';
    return style === 'style2' ? prefix + '-card-style2' : prefix + '-card-style1';
  };
  const mobileCardStyleClass = getCardStyleGridClass(S.mobile_layout_card_style, 'mobile');
  const desktopCardStyleClass = getCardStyleGridClass(S.layout_card_style, 'desktop');
  let gridClass = 'grid w-full ' + getMobileGridClass(S.mobile_layout_grid_cols) + ' ' + getDesktopGridClass(S.layout_grid_cols) + ' ' + mobileCardStyleClass + ' ' + desktopCardStyleClass + ' gap-2.5 sm:gap-3 justify-items-stretch';

  // === 12. 计算文本和统计信息 ===
  const headingPlainText = currentCatalogName ? (currentCatalogName + ' · ' + sites.length + ' 个书签') : ('全部收藏 · ' + sites.length + ' 个书签');
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
  const searchEngineOptions = S.home_search_engine_enabled ? (
    '<div class="flex justify-center items-center gap-3 mb-4 text-sm select-none search-engine-wrapper">' +
    '<label class="search-engine-option active" data-engine="local"><span>站内</span></label>' +
    '<label class="search-engine-option" data-engine="google"><span>Google</span></label>' +
    '<label class="search-engine-option" data-engine="baidu"><span>Baidu</span></label>' +
    '<label class="search-engine-option" data-engine="github"><span>Github</span></label>' +
    '</div>'
  ) : '';

  // === 14. Header HTML ===
  const safeSiteName = escapeHTML(siteName);
  const safeSiteDesc = escapeHTML(siteDescription);
  const horizontalTitleHtml = S.layout_hide_title ? '' : ('<h1 class="text-3xl md:text-4xl font-bold tracking-tight mb-3 ' + titleColorClass + '" ' + titleStyle + '>' + safeSiteName + '</h1>');
  const horizontalSubtitleHtml = S.layout_hide_subtitle ? '' : ('<p class="' + subTextColorClass + ' opacity-90 text-sm md:text-base" ' + subtitleStyle + '>' + safeSiteDesc + '</p>');
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
  const horizontalMoreHtml = categoryFlow === 'multi_line' ? '' : (
    '<div id="horizontalMoreWrapper" class="relative hidden">' +
    '<button id="horizontalMoreBtn" class="nav-btn inactive">' +
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" /></svg>' +
    '</button>' +
    '<div id="horizontalMoreDropdown" class="dropdown-menu hidden absolute mt-2 w-auto z-50"></div>' +
    '</div>'
  );

  const horizontalCategoryNavHtml = (
    '<div class="' + horizontalCategoryNavShellClass + '">' +
    '<div id="horizontalCategoryNav" class="flex ' + horizontalCategoryNavWrapClass + ' ' + horizontalCategoryNavJustifyClass + ' items-center gap-3 ' + horizontalCategoryNavOverflowClass + ' ' + horizontalCategoryNavFlowClass + ' transition-all duration-300">' +
    horizontalCatalogMarkup +
    horizontalMoreHtml +
    '</div>' +
    '</div>'
  );

  const searchBoxInner = (
    searchEngineOptions +
    '<div class="home-search-field relative">' +
    '<input type="search" placeholder="搜索书签..." class="search-input-target w-full pl-12 pr-4 py-3.5 rounded-2xl transition-all shadow-lg outline-none focus:outline-none focus:ring-2 ' + searchInputClass + '" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="search" enterkeyhint="search" aria-label="搜索书签" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">' +
    '<svg xmlns="http://www.w3.org/2000/svg" class="home-search-icon h-6 w-6 absolute left-4 top-3.5 ' + searchIconClass + '" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>' +
    '</div>'
  );

  const verticalHeaderContent = (
    '<div class="max-w-4xl mx-auto text-center relative z-10 ' + themeClass + ' py-8">' +
    '<div class="home-title-block mb-8">' + horizontalTitleHtml + horizontalSubtitleHtml + '</div>' +
    '<div class="home-search-shell relative max-w-xl mx-auto">' + searchBoxInner + '</div>' +
    '</div>'
  );

  const horizontalHeaderContent = (
    '<div class="max-w-5xl mx-auto text-center relative z-10 ' + themeClass + '">' +
    (categoryPosition === 'top' ? ('<div class="category-nav-top-wrap">' + horizontalCategoryNavHtml + '</div>') : '') +
    '<div class="home-title-block max-w-4xl mx-auto mb-8">' + horizontalTitleHtml + horizontalSubtitleHtml + '</div>' +
    (categoryPosition === 'above_search' ? ('<div class="mb-6">' + horizontalCategoryNavHtml + '</div>') : '') +
    '<div class="home-search-shell relative max-w-xl mx-auto ' + (categoryPosition === 'below_search' ? 'mb-6' : '') + '">' + searchBoxInner + '</div>' +
    (categoryPosition === 'below_search' ? horizontalCategoryNavHtml : '') +
    '</div>'
  );

  // === 15. 布局控制 ===
  let sidebarClass = '';
  let mainClass = 'lg:ml-64';
  let sidebarToggleClass = '';
  let mobileToggleVisibilityClass = 'lg:hidden';
  let adminIconHtml = '';
  const themeIconHtml = (
    '<button id="themeToggleBtn" class="top-action-icon theme-action-icon" title="切换主题">' +
    '<svg id="themeIconSun" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="block dark:hidden"><circle cx="12" cy="12" r="5"></circle><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path></svg>' +
    '<svg id="themeIconMoon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden dark:block"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>' +
    '</button>'
  );

  let headerContent = verticalHeaderContent;

  if (isHorizontalCategoryLayout) {
    sidebarClass = 'min-[550px]:hidden';
    mainClass = '';
    sidebarToggleClass = '!hidden';
    mobileToggleVisibilityClass = 'min-[550px]:hidden';

    if (!S.home_hide_admin) {
      adminIconHtml = (
        '<a href="/admin" target="_blank" class="top-action-icon admin-action-icon" title="后台管理">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M7 18a5 5 0 0 1 10 0"/></svg>' +
        '</a>'
      );
    }

    headerContent = (
      '<div class="min-[550px]:hidden">' + verticalHeaderContent + '</div>' +
      '<div class="hidden min-[550px]:block">' + horizontalHeaderContent + '</div>'
    );
  }

  const topRightActionsHtml = '<div class="fixed top-4 right-4 z-50 flex items-center gap-3">' + themeIconHtml + adminIconHtml + '</div>';
  const leftTopActionHtml = (
    '<div class="fixed top-4 left-4 z-50 ' + mobileToggleVisibilityClass + '">' +
    '<button id="sidebarToggle" class="p-2 rounded-lg bg-white dark:bg-gray-800 shadow-md hover:bg-gray-100 dark:hover:bg-gray-700">' +
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-primary-500 dark:text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" /></svg>' +
    '</button>' +
    '</div>'
  );

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
    const blurStyle = S.layout_enable_bg_blur ? ('filter: blur(' + S.layout_bg_blur_intensity + 'px); transform: scale(1.02);') : '';
    bgLayerHtml = '<div id="fixed-background" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -9999; pointer-events: none; overflow: hidden;"><img src="' + safeWallpaperUrl + '" alt="" fetchpriority="high" style="width: 100%; height: 100%; object-fit: cover; ' + blurStyle + '" /></div>';
  } else {
    bgLayerHtml = '<div id="fixed-background" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -9999; pointer-events: none; background-color: ' + defaultBgColor + ';"></div>';
  }

  if (safeWallpaperUrl) {
    headInjections += '<link rel="preload" as="image" href="' + safeWallpaperUrl + '">\n';
  }

  const mainStyleCss = [
    'html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }',
    '#app-scroll { width: 100%; height: 100%; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; }',
    'body { background-color: transparent !important; }',
    '#fixed-background { transition: background-color 0.3s ease, filter 0.3s ease; }',
    '@supports (-webkit-touch-callout: none) { #fixed-background { height: -webkit-fill-available; } }',
    '#app-scroll, main, .home-stats-row, section:has(#sitesGrid) { max-width: 100% !important; width: 100% !important; padding-left: 1cm !important; padding-right: 1cm !important; box-sizing: border-box !important; }',
    'section:has(#sitesGrid) > div { width: 100% !important; max-width: 100% !important; background: transparent !important; background-color: transparent !important; border: none !important; box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border-radius: 0 !important; padding: 4px 0 !important; }',
    '.iori-sidebar-tools { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid rgba(156, 163, 175, 0.25); font-size: 0.875rem; }',
    '.iori-sidebar-tool-btn { width: 100%; padding: 0.45rem 0.65rem; border-radius: 0.5rem; border: 1px solid rgba(156, 163, 175, 0.35); background: rgba(255, 255, 255, 0.12); cursor: pointer; display: flex; align-items: center; justify-content: space-between; transition: all 0.15s ease; }',
    '.iori-sidebar-tool-btn:hover { background: rgba(255, 255, 255, 0.22); }',
    '.iori-sidebar-tool-btn.is-active { background: rgba(59, 130, 246, 0.22); border-color: rgba(59, 130, 246, 0.7); font-weight: 600; }',
    '#sitesGrid .site-card, #sitesGrid > a, #sitesGrid > div { background-color: rgba(255, 255, 255, 0.14) !important; border: 1px solid rgba(255, 255, 255, 0.22) !important; border-radius: 6px !important; box-shadow: none !important; backdrop-filter: blur(4px) !important; -webkit-backdrop-filter: blur(4px) !important; transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.12s ease !important; }',
    'html.dark #sitesGrid .site-card, html.dark #sitesGrid > a, html.dark #sitesGrid > div { background-color: rgba(17, 24, 39, 0.18) !important; border-color: rgba(255, 255, 255, 0.1) !important; }',
    '#sitesGrid .site-card:hover, #sitesGrid > a:hover, #sitesGrid > div:hover { background-color: rgba(255, 255, 255, 0.28) !important; border-color: rgba(255, 255, 255, 0.42) !important; box-shadow: none !important; }',
    'html.dark #sitesGrid .site-card:hover, html.dark #sitesGrid > a:hover, html.dark #sitesGrid > div:hover { background-color: rgba(31, 41, 55, 0.34) !important; border-color: rgba(255, 255, 255, 0.22) !important; }',
    'body.iori-drag-mode #sitesGrid > * { cursor: grab !important; outline: 1px dashed rgba(255, 255, 255, 0.45); }',
    'body.iori-drag-mode #sitesGrid > *:active { cursor: grabbing !important; }',
    '#sitesGrid > *.iori-dragging { opacity: 0.45 !important; transform: scale(0.96) !important; }',
    '#sitesGrid > *.iori-drag-over { outline: 2px solid rgba(96, 165, 250, 0.95) !important; background-color: rgba(59, 130, 246, 0.22) !important; }',
    '#sitesGrid { display: grid !important; width: 100% !important; grid-template-columns: repeat(auto-fill, minmax(calc(96px * var(--iori-card-scale, 1)), 1fr)) !important; gap: 8px !important; justify-items: stretch !important; }',
    '#sitesGrid > * { width: 100% !important; min-width: 0 !important; max-width: none !important; padding: calc(8px * var(--iori-card-scale, 1)) calc(6px * var(--iori-card-scale, 1)) !important; box-sizing: border-box !important; }',
    '#sitesGrid > * img, #sitesGrid > * svg { width: calc(32px * var(--iori-card-scale, 1)) !important; height: calc(32px * var(--iori-card-scale, 1)) !important; max-width: none !important; max-height: none !important; }',
    '#sitesGrid .site-title { font-size: calc(13px * var(--iori-card-scale, 1)) !important; line-height: 1.25 !important; }',
    '@media (max-width: 767px) { #sitesGrid { grid-template-columns: repeat(auto-fill, minmax(calc(72px * var(--iori-card-scale, 1)), 1fr)) !important; gap: 8px 6px !important; } #sitesGrid > * { display: flex !important; flex-direction: column !important; align-items: center !important; text-align: center !important; } #sitesGrid .site-title { font-size: calc(11px * var(--iori-card-scale, 1)) !important; margin-top: 4px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; } #sitesGrid p { display: none !important; } }'
  ].join('\n');

  headInjections += '<style>\n' + mainStyleCss + '\n</style>';

  const cardRadius = normalizeCssPixelValue(S.layout_card_border_radius, 6);
  const mobileCardRadius = normalizeCssPixelValue(S.mobile_layout_card_border_radius, cardRadius);
  const frostedBlur = normalizeCssPixelValue(S.layout_frosted_glass_intensity, 6);
  const mobileFrostedBlur = normalizeCssPixelValue(S.mobile_layout_frosted_glass_intensity, frostedBlur);
  headInjections += '<style>:root { --card-padding: 0.5rem; --card-radius: ' + cardRadius + 'px; --frosted-glass-blur: ' + frostedBlur + 'px; --iori-card-scale: 1; }@media (max-width: 767px) { :root { --card-radius: ' + mobileCardRadius + 'px; --frosted-glass-blur: ' + mobileFrostedBlur + 'px; } }</style>';

  const usedFonts = new Set();
  if (!S.layout_hide_title && S.home_title_font) usedFonts.add(S.home_title_font);
  if (!S.layout_hide_subtitle && S.home_subtitle_font) usedFonts.add(S.home_subtitle_font);
  if (!S.home_hide_stats && S.home_stats_font) usedFonts.add(S.home_stats_font);
  if (!S.home_hide_hitokoto && S.home_hitokoto_font) usedFonts.add(S.home_hitokoto_font);
  if (S.card_title_font) usedFonts.add(S.card_title_font);
  if (S.card_desc_font) usedFonts.add(S.card_desc_font);
  if (S.mobile_card_title_font) usedFonts.add(S.mobile_card_title_font);
  if (S.mobile_card_desc_font) usedFonts.add(S.mobile_card_desc_font);

  let fontLinksHtml = '';
  let needsFontPreconnect = false;
  usedFonts.forEach(font => {
    if (font && FONT_MAP[font]) {
      fontLinksHtml += '<link rel="stylesheet" href="' + FONT_MAP[font] + '">';
      needsFontPreconnect = true;
    }
  });
  const safeCustomFontUrl = sanitizeUrl(S.home_custom_font_url);
  if (safeCustomFontUrl) fontLinksHtml += '<link rel="stylesheet" href="' + safeCustomFontUrl + '">';
  if (needsFontPreconnect) headInjections += '<link rel="preconnect" href="https://fonts.loli.net" crossorigin>';
  if (safeCustomFontUrl) {
    try {
      const customFontOrigin = new URL(safeCustomFontUrl).origin;
      if (customFontOrigin !== 'https://fonts.loli.net') {
        headInjections += '<link rel="preconnect" href="' + escapeHTML(customFontOrigin) + '" crossorigin>';
      }
    } catch { /* sanitizeUrl 已校验 */ }
  }
  if (env.ICON_API) {
    try {
      const iconOrigin = new URL(env.ICON_API).origin;
      headInjections += '<link rel="preconnect" href="' + escapeHTML(iconOrigin) + '" crossorigin>';
    } catch { /* ICON_API 格式异常时静默跳过 */ }
  }
  if (fontLinksHtml) headInjections += fontLinksHtml;

  let customCardCss = '';
  const desktopCardTitleStyle = getStyleStr(S.card_title_size, S.card_title_color, S.card_title_font).replace('style="', '').replace('"', '');
  const mobileCardTitleStyle = getStyleStr(S.mobile_card_title_size, S.mobile_card_title_color, S.mobile_card_title_font).replace('style="', '').replace('"', '');
  const desktopCardTitleColor = sanitizeStyleColor(S.card_title_color);
  const mobileCardTitleColor = sanitizeStyleColor(S.mobile_card_title_color);
  const desktopCardDescStyle = getStyleStr(S.card_desc_size, S.card_desc_color, S.card_desc_font).replace('style="', '').replace('"', '');
  const mobileCardDescStyle = getStyleStr(S.mobile_card_desc_size, S.mobile_card_desc_color, S.mobile_card_desc_font).replace('style="', '').replace('"', '');
  if (desktopCardTitleStyle || mobileCardTitleStyle) {
    if (desktopCardTitleStyle) customCardCss += '@media (min-width: 768px) { .site-title { ' + desktopCardTitleStyle + ' } }';
    if (mobileCardTitleStyle) customCardCss += '@media (max-width: 767px) { .site-title { ' + mobileCardTitleStyle + ' } }';
  }
  if (desktopCardTitleColor) customCardCss += '@media (min-width: 768px) { body { --desktop-card-title-color: ' + desktopCardTitleColor + '; } }';
  if (mobileCardTitleColor) customCardCss += '@media (max-width: 767px) { body { --mobile-card-title-color: ' + mobileCardTitleColor + '; } }';
  if (desktopCardDescStyle || mobileCardDescStyle) {
    if (desktopCardDescStyle) customCardCss += '@media (min-width: 768px) { .site-card p { ' + desktopCardDescStyle + ' } }';
    if (mobileCardDescStyle) customCardCss += '@media (max-width: 767px) { .site-card p { ' + mobileCardDescStyle + ' } }';
  }
  if (customCardCss) headInjections += '<style>' + customCardCss + '</style>';

  const cardHydrationState = buildCardHydrationState(allSites, S);
  const safeSitesJson = JSON.stringify(cardHydrationState.cards).replace(/</g, '\\u003c');
  const safeCardConfigsJson = JSON.stringify(cardHydrationState.configs).replace(/</g, '\\u003c');
  const safeLayoutConfigJson = JSON.stringify({
    hideDesc: S.layout_hide_desc,
    hideLinks: S.layout_hide_links,
    hideCategory: S.layout_hide_category,
    gridCols: S.layout_grid_cols,
    cardStyle: S.layout_card_style,
    cardAnimation: S.layout_card_animation,
    enableFrostedGlass: S.layout_enable_frosted_glass,
    rememberLastCategory: S.home_remember_last_category,
    ssrCatalogId: catalogExists ? requestedCatalogId : 'all',
  }).replace(/</g, '\\u003c');

  html = html.replace('</head>', headInjections + '</head>');

  const pageStyleClasses = [
    S.layout_card_style === 'style3' ? 'desktop-page-style3' : '',
    S.mobile_layout_card_style === 'style3' ? 'mobile-page-style3' : '',
    'category-pos-' + categoryPosition,
  ].filter(Boolean).join(' ');
  html = html.replace(
    '<body class="bg-secondary-50 font-sans text-gray-800">',
    '<body class="bg-secondary-50 dark:bg-gray-900 font-sans text-gray-800 dark:text-gray-100 relative ' + (isCustomWallpaper ? 'custom-wallpaper ' : '') + pageStyleClasses + '">' + bgLayerHtml + '<div id="app-scroll">'
  );

  const sidebarToolsHtml = (
    '<div id="ioriSidebarTools" class="iori-sidebar-tools space-y-3">' +
    '<div class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">标签布局自定义</div>' +
    '<div>' +
    '<div class="flex items-center justify-between text-xs mb-1"><span>标签大小</span><span id="ioriScaleValue">100%</span></div>' +
    '<input id="ioriScaleRange" type="range" min="0.6" max="1.8" step="0.05" value="1" class="w-full cursor-pointer">' +
    '</div>' +
    '<button id="ioriDragToggleBtn" type="button" class="iori-sidebar-tool-btn"><span>自由拖放位置</span><span id="ioriDragStatus" class="text-xs opacity-80">已关闭</span></button>' +
    '<button id="ioriResetLayoutBtn" type="button" class="iori-sidebar-tool-btn"><span>恢复默认大小与位置</span><span class="text-xs opacity-70">重置</span></button>' +
    '</div>'
  );

  if (html.includes('</aside>')) {
    html = html.replace('</aside>', sidebarToolsHtml + '</aside>');
  }

  const clientScriptLines = [
    '<script>(function () {',
    '  var SCALE_KEY = "iori_tag_scale_v1";',
    '  var ORDER_KEY = "iori_tag_order_v1";',
    '  var dragEnabled = false;',
    '  var draggedEl = null;',
    '  function getCardKey(el, idx) {',
    '    var link = el.matches("a[href]") ? el : el.querySelector("a[href]");',
    '    var href = link ? link.getAttribute("href") : "";',
    '    var title = (el.querySelector(".site-title") || el).textContent || "";',
    '    return (href + "|" + title.trim()) || ("idx-" + idx);',
    '  }',
    '  function applyScale(val) {',
    '    var num = Math.min(1.8, Math.max(0.6, parseFloat(val) || 1));',
    '    document.documentElement.style.setProperty("--iori-card-scale", String(num));',
    '    var grid = document.getElementById("sitesGrid");',
    '    if (grid) grid.style.setProperty("--iori-card-scale", String(num));',
    '    var range = document.getElementById("ioriScaleRange");',
    '    var label = document.getElementById("ioriScaleValue");',
    '    if (range) range.value = String(num);',
    '    if (label) label.textContent = Math.round(num * 100) + "%";',
    '    try { localStorage.setItem(SCALE_KEY, String(num)); } catch (e) {}',
    '  }',
    '  function saveOrder() {',
    '    var grid = document.getElementById("sitesGrid");',
    '    if (!grid) return;',
    '    var keys = Array.from(grid.children).map(function (el, i) { return getCardKey(el, i); });',
    '    try { localStorage.setItem(ORDER_KEY, JSON.stringify(keys)); } catch (e) {}',
    '  }',
    '  function applySavedOrder() {',
    '    var grid = document.getElementById("sitesGrid");',
    '    if (!grid) return;',
    '    var saved = null;',
    '    try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || "null"); } catch (e) {}',
    '    if (!Array.isArray(saved) || !saved.length) return;',
    '    var items = Array.from(grid.children);',
    '    var map = new Map();',
    '    items.forEach(function (el, i) {',
    '      var k = getCardKey(el, i);',
    '      if (!map.has(k)) map.set(k, []);',
    '      map.get(k).push(el);',
    '    });',
    '    saved.forEach(function (k) {',
    '      var bucket = map.get(k);',
    '      if (bucket && bucket.length) grid.appendChild(bucket.shift());',
    '    });',
    '    map.forEach(function (bucket) {',
    '      bucket.forEach(function (el) { grid.appendChild(el); });',
    '    });',
    '  }',
    '  function bindDragEvents() {',
    '    var grid = document.getElementById("sitesGrid");',
    '    if (!grid) return;',
    '    Array.from(grid.children).forEach(function (item) {',
    '      item.setAttribute("draggable", dragEnabled ? "true" : "false");',
    '      if (item.dataset.ioriDragBound) return;',
    '      item.dataset.ioriDragBound = "1";',
    '      item.addEventListener("click", function (e) { if (dragEnabled) { e.preventDefault(); e.stopPropagation(); } }, true);',
    '      item.addEventListener("dragstart", function (e) {',
    '        if (!dragEnabled) return;',
    '        draggedEl = item;',
    '        item.classList.add("iori-dragging");',
    '        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", ""); }',
    '      });',
    '      item.addEventListener("dragover", function (e) {',
    '        if (!dragEnabled || !draggedEl || draggedEl === item) return;',
    '        e.preventDefault();',
    '        item.classList.add("iori-drag-over");',
    '      });',
    '      item.addEventListener("dragleave", function () { item.classList.remove("iori-drag-over"); });',
    '      item.addEventListener("drop", function (e) {',
    '        if (!dragEnabled || !draggedEl || draggedEl === item) return;',
    '        e.preventDefault();',
    '        item.classList.remove("iori-drag-over");',
    '        var children = Array.from(grid.children);',
    '        if (children.indexOf(draggedEl) < children.indexOf(item)) grid.insertBefore(draggedEl, item.nextSibling);',
    '        else grid.insertBefore(draggedEl, item);',
    '        saveOrder();',
    '      });',
    '      item.addEventListener("dragend", function () {',
    '        item.classList.remove("iori-dragging");',
    '        grid.querySelectorAll(".iori-drag-over").forEach(function (el) { el.classList.remove("iori-drag-over"); });',
    '        draggedEl = null;',
    '      });',
    '    });',
    '  }',
    '  function setDragMode(enabled) {',
    '    dragEnabled = Boolean(enabled);',
    '    document.body.classList.toggle("iori-drag-mode", dragEnabled);',
    '    var btn = document.getElementById("ioriDragToggleBtn");',
    '    var status = document.getElementById("ioriDragStatus");',
    '    if (btn) btn.classList.toggle("is-active", dragEnabled);',
    '    if (status) status.textContent = dragEnabled ? "开启中" : "已关闭";',
    '    bindDragEvents();',
    '  }',
    '  function initCustomLayout() {',
    '    var savedScale = "1";',
    '    try { savedScale = localStorage.getItem(SCALE_KEY) || "1"; } catch (e) {}',
    '    applyScale(savedScale);',
    '    applySavedOrder();',
    '    bindDragEvents();',
    '    var range = document.getElementById("ioriScaleRange");',
    '    if (range && !range.dataset.bound) { range.dataset.bound = "1"; range.addEventListener("input", function () { applyScale(range.value); }); }',
    '    var dragBtn = document.getElementById("ioriDragToggleBtn");',
    '    if (dragBtn && !dragBtn.dataset.bound) { dragBtn.dataset.bound = "1"; dragBtn.addEventListener("click", function () { setDragMode(!dragEnabled); }); }',
    '    var resetBtn = document.getElementById("ioriResetLayoutBtn");',
    '    if (resetBtn && !resetBtn.dataset.bound) {',
    '      resetBtn.dataset.bound = "1";',
    '      resetBtn.addEventListener("click", function () {',
    '        try { localStorage.removeItem(SCALE_KEY); localStorage.removeItem(ORDER_KEY); } catch (e) {}',
    '        applyScale(1); setDragMode(false); location.reload();',
    '      });',
    '    }',
    '  }',
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCustomLayout); else initCustomLayout();',
    '  var grid = document.getElementById("sitesGrid");',
    '  if (grid && typeof MutationObserver !== "undefined") {',
    '    new MutationObserver(function () {',
    '      var r = document.getElementById("ioriScaleRange");',
    '      applyScale(r ? r.value : (localStorage.getItem(SCALE_KEY) || "1"));',
    '      applySavedOrder();',
    '      bindDragEvents();',
    '    }).observe(grid, { childList: true });',
    '  }',
    '})();</script>'
  ].join('\n');

  html = html.replace('</body>', clientScriptLines + '</div></body>');

  const mainJsMarker = '<script src="/js/main.js';
  if (!html.includes(mainJsMarker)) {
    console.error('Card hydration injection skipped: main.js marker not found in template');
  } else {
    html = html.replace(
      mainJsMarker,
      () => '<script>window.IORI_SITES=' + safeSitesJson + ';window.IORI_CARD_CONFIGS=' + safeCardConfigsJson + ';window.IORI_LAYOUT_CONFIG=' + safeLayoutConfigJson + ';</script>\n  ' + mainJsMarker
    );
  }

  const canonicalUrl = url.origin + '/';
  const ogImageUrl = url.origin + '/favicon.svg';
  const replacements = {
    'HEADER_CONTENT': headerContent,
    'HEADER_CLASS': headerClass,
    'CONTAINER_CLASS': containerClass,
    'FOOTER_CLASS': footerClass,
    'HITOKOTO_CLASS': hitokotoClass,
    'LEFT_TOP_ACTION': leftTopActionHtml,
    'RIGHT_TOP_ACTION': topRightActionsHtml,
    'SITE_NAME': escapeHTML(siteName),
    'SITE_DESCRIPTION': escapeHTML(siteDescription),
    'CANONICAL_URL': escapeHTML(canonicalUrl),
    'OG_IMAGE_URL': escapeHTML(ogImageUrl),
    'FOOTER_TEXT': escapeHTML(footerText),
    'CATALOG_EXISTS': catalogExists ? 'true' : 'false',
    'CATALOG_LINKS': catalogLinkMarkup,
    'SUBMISSION_CLASS': submissionClass,
    'HEADING_TEXT': headingText,
    'HEADING_DEFAULT': headingDefaultAttr,
    'HEADING_ACTIVE': headingActiveAttr,
    'STATS_VISIBLE': S.home_hide_stats ? 'hidden' : '',
    'STATS_STYLE': statsStyle,
    'HITOKOTO_VISIBLE': S.home_hide_hitokoto ? 'hidden' : '',
    'STATS_ROW_PY_CLASS': statsRowPyClass,
    'STATS_ROW_HIDDEN': statsRowHiddenClass,
    'HITOKOTO_CONTENT': hitokotoContent,
    'HITOKOTO_STYLE': hitokotoStyle,
    'SITES_GRID': sitesGridMarkup,
    'CURRENT_YEAR': String(new Date().getFullYear()),
    'SIDEBAR_CLASS': sidebarClass,
    'MAIN_CLASS': mainClass,
    'SIDEBAR_TOGGLE_CLASS': sidebarToggleClass,
  };
  html = html.replace(/\{\{(\w+)\}\}/g, (_, key) => replacements[key] ?? '');
  html = html.replace('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6', gridClass);

  html = html.replace(
    /class="([^"]*?)max-w-(?:4xl|5xl|6xl|7xl)([^"]*?)"/g,
    (_, before, after) => 'class="' + before + 'max-w-full' + after + '"'
  );

  html = html.replace(/>\s+</g, '><');

  // === 17. 返回响应 ===
  const response = new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': isAuthenticated ? 'private, no-store, max-age=0' : 'public, max-age=0, must-revalidate',
    }
  });

  if (shouldClearCookie) {
    response.headers.append('Set-Cookie', 'iori_cache_stale=; Path=/; Max-Age=0; SameSite=Lax');
    response.headers.append('Set-Cookie', 'iori_cache_public_stale=; Path=/; Max-Age=0; SameSite=Lax');
    response.headers.append('Set-Cookie', 'iori_cache_private_stale=; Path=/; Max-Age=0; SameSite=Lax');
  }

  if (isHomePage && cacheGeneration !== null) {
    context.waitUntil((async () => {
      try {
        const wrote = await writeHomeCacheIfUnchanged(env, cacheScope, html, cacheGeneration);
        if (wrote && cacheDirty) {
          await clearHomeCacheDirtyIfValue(env, cacheScope, cacheDirtyValue);
        }
      } catch (e) {
        console.warn('Failed to update home cache:', e);
      }
    })());
  }

  return response;
}