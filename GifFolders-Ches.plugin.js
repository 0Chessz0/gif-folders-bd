/**
 * @name GifFolders
 * @description Adds persistent folders for your existing Discord favorite GIFs.
 * @version 1.2.2
 * @author Ches
 * @authorLink https://github.com/0Chessz0
 */

module.exports = class GifFolders {
    constructor() {
        this.api = new BdApi("GifFolders");
        this.styleId = "GifFolders-style";
        this.tileId = "giffolders-home-tile";
        this.overlayId = "giffolders-overlay";
        this.observer = null;
        this.refreshTimer = null;
        this.injectQueued = false;
        this.overlay = null;
        this.overlayRoot = null;
        this.rootOldPosition = null;
        this.lastDragEnd = 0;
        this.favoriteFingerprint = "";
        this.homeTarget = null;
        this.captureClickHandler = null;
        this.captureKeyHandler = null;
        this.dragState = null;
        this.dialogOpen = false;
        this.activeDialog = null;
        this.sendingGif = false;
        this.state = this.loadState();

        this.FrecencyUserSettings = null;
        this.SelectedChannelStore = null;
        this.MessageActions = null;
        this.ComponentDispatch = null;
        this.RestAPI = null;
    }

    start() {
        this.resolveModules();
        this.addStyles();
        this.startWatching();
        this.loadFavorites().finally(() => this.queueHomeTileInjection());
    }

    stop() {
        if (this.observer) this.observer.disconnect();
        this.observer = null;

        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;

        if (this.captureClickHandler) document.removeEventListener("click", this.captureClickHandler, true);
        this.captureClickHandler = null;
        if (this.captureKeyHandler) document.removeEventListener("keydown", this.captureKeyHandler, true);
        this.captureKeyHandler = null;
        this.cancelPointerDrag();

        this.closeFolderView();
        document.getElementById(this.tileId)?.remove();
        this.homeTarget = null;
        this.api.DOM.removeStyle(this.styleId);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "gf-settings";

        const title = document.createElement("div");
        title.className = "gf-settings-title";
        title.textContent = "GIF Folders";

        const description = document.createElement("div");
        description.className = "gf-settings-note";
        description.textContent = "Folders only organize your existing Discord favorite GIFs. The plugin never removes GIFs from Discord Favorites.";

        const row = document.createElement("div");
        row.className = "gf-settings-row";

        const textWrap = document.createElement("div");
        const rowTitle = document.createElement("div");
        rowTitle.className = "gf-settings-row-title";
        rowTitle.textContent = "Reset GIF Folders";
        const rowNote = document.createElement("div");
        rowNote.className = "gf-settings-note";
        rowNote.textContent = "Deletes your custom folder layout and puts every favorite back in Default. Your Discord favorites are left untouched.";
        textWrap.append(rowTitle, rowNote);

        const reset = document.createElement("button");
        reset.className = "gf-settings-reset";
        reset.textContent = "Reset";
        reset.addEventListener("click", () => this.confirmReset());

        row.append(textWrap, reset);
        panel.append(title, description, row);
        return panel;
    }

    defaultState() {
        return {
            version: 2,
            folders: [],
            assignments: {},
            orders: {},
            selectedFolder: "default"
        };
    }

    loadState() {
        const saved = this.api.Data.load("state");
        if (!saved || typeof saved !== "object") return this.defaultState();

        const state = this.defaultState();
        state.folders = Array.isArray(saved.folders)
            ? saved.folders
                .filter(folder => folder && typeof folder.id === "string" && typeof folder.name === "string")
                .filter(folder => folder.id !== "default")
                .map(folder => ({id: folder.id, name: folder.name.trim() || "Folder"}))
            : [];
        state.assignments = saved.assignments && typeof saved.assignments === "object" ? saved.assignments : {};
        state.orders = saved.orders && typeof saved.orders === "object"
            ? Object.fromEntries(Object.entries(saved.orders).map(([folderId, urls]) => [
                folderId,
                Array.isArray(urls) ? urls.filter(url => typeof url === "string") : []
            ]))
            : {};
        state.selectedFolder = typeof saved.selectedFolder === "string" ? saved.selectedFolder : "default";

        if (state.selectedFolder !== "default" && !state.folders.some(folder => folder.id === state.selectedFolder)) {
            state.selectedFolder = "default";
        }

        return state;
    }

    saveState() {
        this.api.Data.save("state", this.state);
    }

    resolveModules() {
        const {Webpack} = BdApi;

        this.SelectedChannelStore = Webpack.getStore("SelectedChannelStore");

        this.MessageActions = Webpack.getModule(Webpack.Filters.byKeys("sendMessage")) ||
            Webpack.getByKeys("sendMessage", "editMessage") ||
            Webpack.getModule(
                module => typeof module?.sendMessage === "function" && typeof module?.editMessage === "function",
                {searchExports: true}
            );

        this.ComponentDispatch = Webpack.getAllByKeys?.(
            "safeDispatch",
            "dispatchToLastSubscribed",
            {searchExports: true}
        )?.find(module => module?.options?.logger != null) ||
            Webpack.getModule(
                module => typeof module?.dispatchToLastSubscribed === "function" &&
                    typeof module?.safeDispatch === "function",
                {searchExports: true}
            );

        this.RestAPI = Webpack.getModule(
            module => module && typeof module === "object" &&
                typeof module.get === "function" &&
                typeof module.post === "function" &&
                typeof module.put === "function" &&
                typeof module.del === "function",
            {searchExports: true}
        );

        this.FrecencyUserSettings = Webpack.getModule(
            module => module?.ProtoClass?.typeName?.endsWith?.(".FrecencyUserSettings") && typeof module?.getCurrentValue === "function",
            {searchExports: true}
        );

        if (!this.FrecencyUserSettings) {
            this.api.Logger.warn("Could not find Discord's FrecencyUserSettings module. Favorite GIFs may not load until Discord is updated or reloaded.");
        }
    }

    async loadFavorites() {
        try {
            await this.FrecencyUserSettings?.loadIfNecessary?.();
        } catch (error) {
            this.api.Logger.warn("Failed to preload favorite GIF settings", error);
        }
    }

    getFavorites() {
        try {
            const gifs = this.FrecencyUserSettings?.getCurrentValue?.()?.favoriteGifs?.gifs;
            if (!gifs || typeof gifs !== "object") return [];

            return Object.entries(gifs)
                .map(([url, meta]) => ({
                    url,
                    src: meta?.src || url,
                    format: Number(meta?.format ?? 0),
                    width: Number(meta?.width ?? 0),
                    height: Number(meta?.height ?? 0),
                    order: Number(meta?.order ?? 0)
                }))
                .sort((a, b) => b.order - a.order);
        } catch (error) {
            this.api.Logger.error("Failed to read favorite GIFs", error);
            return [];
        }
    }

    getFavoriteFingerprint() {
        return this.getFavorites().map(gif => `${gif.url}:${gif.order}`).join("|");
    }

    folderExists(folderId) {
        return folderId === "default" || this.state.folders.some(folder => folder.id === folderId);
    }

    getFolderIdForGif(url) {
        const assigned = this.state.assignments[url];
        return assigned && this.folderExists(assigned) ? assigned : "default";
    }

    getGifsForFolder(folderId) {
        const gifs = this.getFavorites().filter(gif => this.getFolderIdForGif(gif.url) === folderId);
        const byUrl = new Map(gifs.map(gif => [gif.url, gif]));
        const ordered = [];

        for (const url of this.state.orders[folderId] || []) {
            const gif = byUrl.get(url);
            if (!gif) continue;
            ordered.push(gif);
            byUrl.delete(url);
        }

        return [...ordered, ...byUrl.values()];
    }

    moveGif(url, targetFolderId, beforeUrl = null) {
        if (!this.folderExists(targetFolderId)) return;

        const targetOrder = this.getGifsForFolder(targetFolderId)
            .map(gif => gif.url)
            .filter(itemUrl => itemUrl !== url);

        const insertAt = beforeUrl ? targetOrder.indexOf(beforeUrl) : -1;
        if (insertAt >= 0) targetOrder.splice(insertAt, 0, url);
        else targetOrder.push(url);

        for (const folderId of Object.keys(this.state.orders)) {
            this.state.orders[folderId] = this.state.orders[folderId].filter(itemUrl => itemUrl !== url);
        }

        if (targetFolderId === "default") delete this.state.assignments[url];
        else this.state.assignments[url] = targetFolderId;
        this.state.orders[targetFolderId] = targetOrder;

        this.saveState();
        this.renderFolderView();
    }

    startWatching() {
        this.observer = new MutationObserver(() => this.queueHomeTileInjection());
        this.observer.observe(document.body, {childList: true, subtree: true});

        this.captureClickHandler = event => this.handleCapturedClick(event);
        document.addEventListener("click", this.captureClickHandler, true);
        this.captureKeyHandler = event => {
            if (event.key !== "Escape") return;
            if (this.activeDialog) {
                event.preventDefault();
                event.stopPropagation();
                this.closeOverlayDialog();
            } else if (document.getElementById(this.overlayId)) {
                this.closeFolderView();
            }
        };
        document.addEventListener("keydown", this.captureKeyHandler, true);

        this.refreshTimer = setInterval(() => {
            this.queueHomeTileInjection();

            if (document.getElementById(this.overlayId)) {
                if (!this.overlayRoot?.isConnected || !this.isVisible(this.overlayRoot)) {
                    this.closeFolderView();
                    return;
                }
                this.positionOverlay();
                const fingerprint = this.getFavoriteFingerprint();
                if (fingerprint !== this.favoriteFingerprint) {
                    this.favoriteFingerprint = fingerprint;
                    this.renderFolderView();
                }
            }
        }, 500);
    }

    handleCapturedClick(event) {
        const overlay = document.getElementById(this.overlayId);
        if (overlay) {
            if (!overlay.contains(event.target)) this.closeFolderView();
            return;
        }
        if (!this.homeTarget?.isConnected || !this.isVisible(this.homeTarget)) return;

        const rect = this.homeTarget.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.homeTarget.blur?.();

        const liveHome = this.findGifHomeGrid();
        const viewport = liveHome && this.findGifViewport(liveHome.grid);
        if (!viewport) {
            BdApi.UI.showToast("Could not open GIF Folders. Close and reopen the GIF picker.", {type: "error"});
            return;
        }

        this.homeTarget = liveHome.trendingCard;
        this.openFolderView(viewport);
    }

    queueHomeTileInjection() {
        if (this.injectQueued) return;
        this.injectQueued = true;
        requestAnimationFrame(() => {
            this.injectQueued = false;
            this.injectHomeTile();
        });
    }

    normalizedText(element) {
        return (element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    isVisible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }

    findExactTextElements(text) {
        return [...document.body.querySelectorAll("*")]
            .filter(element => this.isVisible(element))
            .filter(element => this.normalizedText(element) === text)
            .filter(element => ![...element.children].some(child => this.normalizedText(child) === text));
    }

    directChildBelow(ancestor, descendant) {
        let node = descendant;
        while (node?.parentElement && node.parentElement !== ancestor) node = node.parentElement;
        return node?.parentElement === ancestor ? node : null;
    }

    findSharedCardRow(firstLabel, secondLabel) {
        let node = firstLabel;

        for (let depth = 0; node?.parentElement && depth < 10; depth++, node = node.parentElement) {
            const parent = node.parentElement;
            const firstCard = this.directChildBelow(parent, firstLabel);
            const secondCard = this.directChildBelow(parent, secondLabel);

            if (firstCard && secondCard && firstCard !== secondCard && this.isVisible(parent)) {
                return {grid: parent, favoriteCard: firstCard, trendingCard: secondCard};
            }
        }

        return null;
    }

    findGifHomeGrid() {
        // Discord's GIF home cards are no longer guaranteed to be buttons. Search
        // their visible labels instead, then find the first shared row/grid that
        // owns both cards. This survives Discord changing the wrapper element or
        // removing tabindex/role attributes from the cards.
        const favoriteLabels = this.findExactTextElements("Favorites");
        const trendingLabels = this.findExactTextElements("Trending GIFs");

        for (const favoriteLabel of favoriteLabels) {
            for (const trendingLabel of trendingLabels) {
                const home = this.findSharedCardRow(favoriteLabel, trendingLabel);
                if (home) return home;
            }
        }

        // Compatibility fallback for older Discord builds.
        const clickables = [...document.querySelectorAll('button, [role="button"], [tabindex="0"]')]
            .filter(element => this.isVisible(element));

        const favorite = clickables.find(element => this.normalizedText(element) === "Favorites");
        if (!favorite) return null;

        let node = favorite;
        for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
            const parent = node.parentElement;
            if (!parent) break;

            const children = [...parent.children];
            const favoriteCard = children.find(child => child === node || child.contains(favorite));
            const trendingCard = children.find(child => /Trending GIFs/i.test(this.normalizedText(child)));

            if (favoriteCard && trendingCard && favoriteCard !== trendingCard) {
                return {grid: parent, favoriteCard, trendingCard};
            }
        }

        return null;
    }

    findGifViewport(fromElement) {
        let fallback = null;
        let node = fromElement;
        for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
            const rect = node.getBoundingClientRect?.();
            if (!rect || rect.width < 350 || rect.width > 900 || rect.height < 180 || rect.height > 900) continue;

            const style = getComputedStyle(node);
            const scrolls = /(auto|scroll)/.test(style.overflowY) || node.scrollHeight > node.clientHeight + 4;
            if (scrolls) return node;

            if (!fallback) fallback = node;
        }
        return fallback || fromElement;
    }

    injectHomeTile() {
        const currentTile = document.getElementById(this.tileId);

        if (document.getElementById(this.overlayId)) {
            currentTile?.remove();
            return;
        }

        if (currentTile && this.homeTarget?.isConnected && this.isVisible(this.homeTarget)) {
            this.positionHomeTile(currentTile, this.homeTarget);
            return;
        }

        currentTile?.remove();
        this.homeTarget = null;

        const home = this.findGifHomeGrid();
        if (!home) return;

        const tile = document.createElement("div");
        tile.id = this.tileId;
        tile.className = "gf-home-tile gf-floating-tile";
        tile.setAttribute("aria-hidden", "true");
        tile.innerHTML = `
            <div class="gf-home-tile-inner">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Zm10 14H4V8h16v10Z"/>
                </svg>
                <span>GIF Folders</span>
            </div>`;

        this.homeTarget = home.trendingCard;
        document.body.appendChild(tile);
        this.positionHomeTile(tile, home.trendingCard);
    }

    positionHomeTile(tile, target) {
        const rect = target?.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
            tile.style.display = "none";
            return;
        }

        tile.style.display = "block";
        tile.style.left = `${rect.left}px`;
        tile.style.top = `${rect.top}px`;
        tile.style.width = `${rect.width}px`;
        tile.style.height = `${rect.height}px`;
        tile.style.borderRadius = getComputedStyle(target).borderRadius || "8px";
    }

    openFolderView(root) {
        if (!root) return;
        this.closeFolderView();

        this.overlayRoot = root;
        this.rootOldPosition = root.style.position;
        if (getComputedStyle(root).position === "static") root.style.position = "relative";
        root.scrollTop = 0;

        const overlay = document.createElement("div");
        overlay.id = this.overlayId;
        overlay.className = "gf-overlay";
        for (const eventName of ["pointerdown", "mousedown", "click"]) {
            overlay.addEventListener(eventName, event => event.stopPropagation());
        }
        root.appendChild(overlay);
        this.overlay = overlay;
        this.positionOverlay();

        this.favoriteFingerprint = this.getFavoriteFingerprint();
        this.renderFolderView();
    }

    closeFolderView() {
        this.cancelPointerDrag();
        this.closeOverlayDialog();
        this.overlay?.remove();
        this.overlay = null;

        if (this.overlayRoot && this.rootOldPosition !== null) {
            this.overlayRoot.style.position = this.rootOldPosition;
        }
        this.overlayRoot = null;
        this.rootOldPosition = null;

        this.queueHomeTileInjection();
    }

    positionOverlay() {
        if (!this.overlay || !this.overlayRoot?.isConnected || !this.isVisible(this.overlayRoot)) return;

        const rect = this.overlayRoot.getBoundingClientRect();
        this.overlay.style.left = `${this.overlayRoot.scrollLeft}px`;
        this.overlay.style.top = `${this.overlayRoot.scrollTop}px`;
        this.overlay.style.width = `${this.overlayRoot.clientWidth || Math.round(rect.width)}px`;
        this.overlay.style.height = `${this.overlayRoot.clientHeight || Math.round(rect.height)}px`;
    }

    renderFolderView() {
        const overlay = document.getElementById(this.overlayId);
        if (!overlay) return;

        if (!this.folderExists(this.state.selectedFolder)) {
            this.state.selectedFolder = "default";
            this.saveState();
        }

        overlay.replaceChildren();

        const layout = document.createElement("div");
        layout.className = "gf-layout";

        const main = document.createElement("section");
        main.className = "gf-main";

        const mainHeader = document.createElement("div");
        mainHeader.className = "gf-main-header";

        const back = this.makeIconButton("Back to GIFs", this.iconBack(), () => this.closeFolderView());
        back.classList.add("gf-back-button");

        const headingWrap = document.createElement("div");
        headingWrap.className = "gf-heading-wrap";
        const title = document.createElement("div");
        title.className = "gf-title";
        title.textContent = this.getSelectedFolderName();
        const subtitle = document.createElement("div");
        subtitle.className = "gf-subtitle";
        subtitle.textContent = "Click to send · Drag to move";
        headingWrap.append(title, subtitle);
        mainHeader.append(back, headingWrap);

        const grid = document.createElement("div");
        grid.className = "gf-gif-grid";
        this.renderGifGrid(grid);

        main.append(mainHeader, grid);

        const sidebar = document.createElement("aside");
        sidebar.className = "gf-sidebar";
        this.renderSidebar(sidebar);

        layout.append(main, sidebar);
        overlay.append(layout);
    }

    getSelectedFolderName() {
        if (this.state.selectedFolder === "default") return "Default";
        return this.state.folders.find(folder => folder.id === this.state.selectedFolder)?.name || "Default";
    }

    renderGifGrid(grid) {
        const allFavorites = this.getFavorites();
        const gifs = this.getGifsForFolder(this.state.selectedFolder);

        if (!allFavorites.length) {
            grid.append(this.makeEmptyState(
                "No favorite GIFs yet",
                "Favorite some GIFs in Discord first. They will automatically appear in Default."
            ));
            return;
        }

        if (!gifs.length) {
            grid.append(this.makeEmptyState(
                "This folder is empty",
                this.state.selectedFolder === "default"
                    ? "Your unassigned favorites will appear here. Drag a GIF back to Default to return it here."
                    : "Drag GIFs onto this folder from Default or another folder."
            ));
            return;
        }

        for (const gif of gifs) {
            grid.append(this.makeGifCard(gif));
        }
    }

    makeGifCard(gif) {
        const card = document.createElement("button");
        card.className = "gf-gif-card";
        card.type = "button";
        card.title = "Click to send · Drag to move";
        card.setAttribute("aria-label", "Favorite GIF");
        card.dataset.gifUrl = gif.url;

        let media;
        const looksLikeVideo = gif.format === 2 || /\.(mp4|webm)(?:$|\?)/i.test(gif.src);
        if (looksLikeVideo) {
            media = document.createElement("video");
            media.autoplay = true;
            media.loop = true;
            media.muted = true;
            media.playsInline = true;
            media.preload = "metadata";
        } else {
            media = document.createElement("img");
            media.loading = "lazy";
            media.alt = "";
        }
        media.src = gif.src || gif.url;
        media.draggable = false;

        const dragHint = document.createElement("div");
        dragHint.className = "gf-drag-hint";
        dragHint.textContent = "Drag";

        card.append(media, dragHint);

        card.addEventListener("click", event => {
            if (Date.now() - this.lastDragEnd < 250) {
                event.preventDefault();
                return;
            }
            this.sendGif(gif);
        });

        card.addEventListener("pointerdown", event => this.startPointerDrag(event, gif, card));

        return card;
    }

    startPointerDrag(event, gif, card) {
        if (event.button !== 0 || this.dialogOpen) return;
        this.cancelPointerDrag();

        const state = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            gif,
            card,
            moved: false,
            targetFolder: null,
            targetCard: null,
            ghost: null,
            move: null,
            up: null
        };

        state.move = moveEvent => this.updatePointerDrag(moveEvent);
        state.up = upEvent => this.finishPointerDrag(upEvent);
        this.dragState = state;
        document.addEventListener("pointermove", state.move, true);
        document.addEventListener("pointerup", state.up, true);
        document.addEventListener("pointercancel", state.up, true);
    }

    updatePointerDrag(event) {
        const state = this.dragState;
        if (!state || event.pointerId !== state.pointerId) return;

        state.x = event.clientX;
        state.y = event.clientY;
        const distance = Math.hypot(state.x - state.startX, state.y - state.startY);
        if (!state.moved && distance < 7) return;

        event.preventDefault();
        if (!state.moved) {
            state.moved = true;
            state.card.classList.add("gf-dragging");
            state.ghost = this.makeDragGhost(state.gif);
            document.body.appendChild(state.ghost);
        }

        state.ghost.style.left = `${state.x + 14}px`;
        state.ghost.style.top = `${state.y + 14}px`;

        const hovered = document.elementFromPoint(state.x, state.y);
        const targetFolder = hovered?.closest?.(".gf-folder") || null;
        const hoveredCard = hovered?.closest?.(".gf-gif-card") || null;
        const targetCard = hoveredCard && hoveredCard !== state.card ? hoveredCard : null;

        if (targetFolder !== state.targetFolder) {
            state.targetFolder?.classList.remove("gf-drop-target");
            state.targetFolder = targetFolder;
            state.targetFolder?.classList.add("gf-drop-target");
        }
        if (targetCard !== state.targetCard) {
            state.targetCard?.classList.remove("gf-reorder-target");
            state.targetCard = targetCard;
            state.targetCard?.classList.add("gf-reorder-target");
        }
    }

    finishPointerDrag(event) {
        const state = this.dragState;
        if (!state || event.pointerId !== state.pointerId) return;

        const targetFolderId = state.moved
            ? state.targetFolder?.dataset?.folderId || (state.targetCard ? this.state.selectedFolder : null)
            : null;
        const beforeUrl = state.targetCard?.dataset?.gifUrl || null;
        if (state.moved) {
            event.preventDefault();
            event.stopPropagation();
            this.lastDragEnd = Date.now();
        }

        this.cancelPointerDrag();
        if (targetFolderId) this.moveGif(state.gif.url, targetFolderId, beforeUrl);
    }

    cancelPointerDrag() {
        const state = this.dragState;
        if (!state) return;

        document.removeEventListener("pointermove", state.move, true);
        document.removeEventListener("pointerup", state.up, true);
        document.removeEventListener("pointercancel", state.up, true);
        state.card?.classList.remove("gf-dragging");
        state.targetFolder?.classList.remove("gf-drop-target");
        state.targetCard?.classList.remove("gf-reorder-target");
        state.ghost?.remove();
        this.dragState = null;
    }

    makeDragGhost(gif) {
        const ghost = document.createElement("div");
        ghost.className = "gf-drag-ghost";
        const looksLikeVideo = gif.format === 2 || /\.(mp4|webm)(?:$|\?)/i.test(gif.src);
        const media = document.createElement(looksLikeVideo ? "video" : "img");
        media.src = gif.src || gif.url;
        if (looksLikeVideo) {
            media.autoplay = true;
            media.loop = true;
            media.muted = true;
            media.playsInline = true;
        }
        ghost.appendChild(media);
        return ghost;
    }

    isDiscordAttachmentUrl(url) {
        return typeof url === "string" &&
            /^https?:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/attachments\//i.test(url);
    }

    unsignedDiscordAttachmentUrls(url) {
        if (!this.isDiscordAttachmentUrl(url)) return [];

        try {
            const parsed = new URL(url);
            parsed.search = "";
            parsed.hash = "";

            const mediaUrl = parsed.toString();
            if (parsed.hostname.toLowerCase() === "media.discordapp.net") {
                parsed.hostname = "cdn.discordapp.com";
            }

            return [...new Set([parsed.toString(), mediaUrl])];
        } catch {
            return [];
        }
    }

    async refreshDiscordAttachmentUrl(url) {
        if (!this.isDiscordAttachmentUrl(url) || typeof this.RestAPI?.post !== "function") return null;

        try {
            const response = await this.RestAPI.post({
                url: "/attachments/refresh-urls",
                body: {attachment_urls: [url]}
            });
            const body = response?.body || response;
            const refreshed = body?.refreshed_urls?.[0];
            return typeof refreshed === "string"
                ? refreshed
                : refreshed?.refreshed || refreshed?.refreshed_url || refreshed?.url || null;
        } catch (error) {
            this.api.Logger.warn("Could not refresh a Discord attachment URL; trying its permanent form instead.", error);
            return null;
        }
    }

    findMessageComposer() {
        const editors = [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')];
        return editors.find(editor =>
            editor.dataset?.slateEditor === "true" ||
            editor.closest?.('[class*="channelTextArea"]')
        ) || null;
    }

    async sendThroughComposer(url) {
        if (typeof this.ComponentDispatch?.dispatchToLastSubscribed !== "function") return false;

        const editor = this.findMessageComposer();
        if (!editor) return false;

        this.ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", {
            rawText: url,
            plainText: url
        });

        await new Promise(resolve => setTimeout(resolve, 25));
        editor.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            charCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        }));
        return true;
    }

    async sendGif(gif) {
        if (this.sendingGif) return;
        this.sendingGif = true;

        try {
            if (!this.MessageActions) this.resolveModules();
            const channelId = this.SelectedChannelStore?.getCurrentlySelectedChannelId?.() ||
                this.SelectedChannelStore?.getChannelId?.();

            if (!channelId) {
                throw new Error("Could not find the current channel.");
            }

            const originalUrls = [gif.url, gif.src]
                .filter(url => typeof url === "string" && /^https?:\/\//i.test(url));
            const attachmentUrls = originalUrls.filter(url => this.isDiscordAttachmentUrl(url));
            const refreshedUrl = attachmentUrls.length
                ? await this.refreshDiscordAttachmentUrl(attachmentUrls[0])
                : null;
            const unsignedUrls = attachmentUrls.flatMap(url => this.unsignedDiscordAttachmentUrls(url));
            const rawCandidates = attachmentUrls.length
                ? [refreshedUrl, ...unsignedUrls, ...originalUrls]
                : originalUrls;
            const candidates = [...new Set(rawCandidates.filter(url => typeof url === "string" && /^https?:\/\//i.test(url)))];
            if (!candidates.length) throw new Error("No valid URL was available for this GIF.");

            if (await this.sendThroughComposer(candidates[0])) {
                this.closeFolderView();
                return;
            }

            if (!this.MessageActions?.sendMessage) {
                throw new Error("Could not find Discord's composer or sendMessage action.");
            }

            let lastError = null;

            for (const url of candidates) {
                try {
                    await this.MessageActions.sendMessage(channelId, {
                        content: url,
                        tts: false,
                        validNonShortcutEmojis: []
                    });
                    this.closeFolderView();
                    return;
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError || new Error("No valid URL was available for this GIF.");
        } catch (error) {
            this.api.Logger.error("Failed to send GIF", error);
            BdApi.UI.showToast("GIF Folders couldn't send that GIF.", {type: "error"});
        } finally {
            this.sendingGif = false;
        }
    }

    renderSidebar(sidebar) {
        const toolbar = document.createElement("div");
        toolbar.className = "gf-sidebar-toolbar";

        const add = this.makeIconButton("Add folder", this.iconPlus(), () => this.promptCreateFolder());
        const rename = this.makeIconButton("Rename selected folder", this.iconEdit(), () => this.promptRenameSelected());
        const remove = this.makeIconButton("Delete selected folder", this.iconTrash(), () => this.confirmDeleteSelected());

        const defaultSelected = this.state.selectedFolder === "default";
        rename.disabled = defaultSelected;
        remove.disabled = defaultSelected;

        toolbar.append(add, rename, remove);

        const label = document.createElement("div");
        label.className = "gf-sidebar-label";
        label.textContent = "Folders";

        const list = document.createElement("div");
        list.className = "gf-folder-list";

        list.append(this.makeFolderButton({id: "default", name: "Default"}, true));
        for (const folder of this.state.folders) list.append(this.makeFolderButton(folder, false));

        sidebar.append(toolbar, label, list);
    }

    makeFolderButton(folder, locked) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gf-folder";
        if (this.state.selectedFolder === folder.id) button.classList.add("gf-selected");
        button.dataset.folderId = folder.id;

        const icon = document.createElement("span");
        icon.className = "gf-folder-icon";
        icon.innerHTML = this.iconFolder(locked);

        const name = document.createElement("span");
        name.className = "gf-folder-name";
        name.textContent = folder.name;

        const count = document.createElement("span");
        count.className = "gf-folder-count";
        count.textContent = String(this.getGifsForFolder(folder.id).length);

        button.append(icon, name, count);
        button.addEventListener("click", () => {
            this.state.selectedFolder = folder.id;
            this.saveState();
            this.renderFolderView();
        });

        button.addEventListener("dragover", event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            button.classList.add("gf-drop-target");
        });
        button.addEventListener("dragenter", event => {
            event.preventDefault();
            button.classList.add("gf-drop-target");
        });
        button.addEventListener("dragleave", event => {
            if (!button.contains(event.relatedTarget)) button.classList.remove("gf-drop-target");
        });
        button.addEventListener("drop", event => {
            event.preventDefault();
            button.classList.remove("gf-drop-target");
            const url = event.dataTransfer.getData("application/x-giffolders-url") || event.dataTransfer.getData("text/plain");
            if (!url) return;
            this.moveGif(url, folder.id);
        });

        return button;
    }

    makeIconButton(title, icon, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gf-icon-button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.innerHTML = icon;
        button.addEventListener("click", onClick);
        return button;
    }

    makeEmptyState(titleText, noteText) {
        const empty = document.createElement("div");
        empty.className = "gf-empty";
        const icon = document.createElement("div");
        icon.className = "gf-empty-icon";
        icon.innerHTML = this.iconFolder(false);
        const title = document.createElement("div");
        title.className = "gf-empty-title";
        title.textContent = titleText;
        const note = document.createElement("div");
        note.className = "gf-empty-note";
        note.textContent = noteText;
        empty.append(icon, title, note);
        return empty;
    }

    promptCreateFolder() {
        this.showNameDialog("Create folder", "", "Create", name => {
            if (name.toLowerCase() === "default" || this.state.folders.some(folder => folder.name.toLowerCase() === name.toLowerCase())) {
                return "A folder with that name already exists.";
            }
            return null;
        }, clean => {
            const folder = {
                id: `folder_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
                name: clean.slice(0, 40)
            };
            this.state.folders.push(folder);
            this.state.selectedFolder = folder.id;
            this.saveState();
            this.renderFolderView();
        });
    }

    promptRenameSelected() {
        if (this.state.selectedFolder === "default") return;
        const folder = this.state.folders.find(item => item.id === this.state.selectedFolder);
        if (!folder) return;

        this.showNameDialog("Rename folder", folder.name, "Rename", name => {
            if (name.toLowerCase() === "default" || this.state.folders.some(item => item.id !== folder.id && item.name.toLowerCase() === name.toLowerCase())) {
                return "A folder with that name already exists.";
            }
            return null;
        }, clean => {
            folder.name = clean.slice(0, 40);
            this.saveState();
            this.renderFolderView();
        });
    }

    confirmDeleteSelected() {
        if (this.state.selectedFolder === "default") return;
        const folder = this.state.folders.find(item => item.id === this.state.selectedFolder);
        if (!folder) return;

        this.showConfirmDialog(
            "Delete folder",
            `Delete “${folder.name}”? Its GIFs will return to Default. Your Discord favorites will not be changed.`,
            "Delete",
            true,
            () => {
                this.state.folders = this.state.folders.filter(item => item.id !== folder.id);
                for (const [url, folderId] of Object.entries(this.state.assignments)) {
                    if (folderId === folder.id) delete this.state.assignments[url];
                }
                delete this.state.orders[folder.id];
                this.state.selectedFolder = "default";
                this.saveState();
                this.renderFolderView();
            }
        );
    }

    confirmReset() {
        BdApi.UI.showConfirmationModal(
            "Reset GIF Folders",
            "Reset all GIF Folders data? All custom folders will be deleted and every favorite GIF will appear in Default again. Your normal Discord Favorites will not be changed.",
            {
                danger: true,
                confirmText: "Reset",
                cancelText: "Cancel",
                onConfirm: () => {
                    this.state = this.defaultState();
                    this.saveState();
                    this.renderFolderView();
                    BdApi.UI.showToast("GIF Folders has been reset.", {type: "success"});
                }
            }
        );
    }

    showNameDialog(title, initialValue, confirmText, validate, onConfirm) {
        if (this.dialogOpen || !this.overlay) return;

        const backdrop = this.makeDialogShell(title);
        const body = backdrop.querySelector(".gf-dialog-body");
        const input = document.createElement("input");
        input.className = "gf-dialog-input";
        input.value = initialValue;
        input.maxLength = 40;
        input.placeholder = "Folder name";

        const error = document.createElement("div");
        error.className = "gf-dialog-error";
        body.append(input, error);

        const submit = () => {
            const clean = input.value.trim();
            const message = !clean ? "Enter a folder name." : validate(clean);
            if (message) {
                error.textContent = message;
                input.focus();
                return;
            }
            this.closeOverlayDialog();
            onConfirm(clean);
        };

        this.addDialogButtons(backdrop, confirmText, false, submit);
        input.addEventListener("input", () => error.textContent = "");
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();
                submit();
            }
        });
        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }

    showConfirmDialog(title, message, confirmText, danger, onConfirm) {
        if (this.dialogOpen || !this.overlay) return;

        const backdrop = this.makeDialogShell(title);
        const body = backdrop.querySelector(".gf-dialog-body");
        const text = document.createElement("div");
        text.className = "gf-dialog-message";
        text.textContent = message;
        body.appendChild(text);

        this.addDialogButtons(backdrop, confirmText, danger, () => {
            this.closeOverlayDialog();
            onConfirm();
        });
    }

    makeDialogShell(titleText) {
        this.dialogOpen = true;
        const backdrop = document.createElement("div");
        backdrop.className = "gf-dialog-backdrop";

        const dialog = document.createElement("div");
        dialog.className = "gf-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");

        const title = document.createElement("div");
        title.className = "gf-dialog-title";
        title.textContent = titleText;

        const body = document.createElement("div");
        body.className = "gf-dialog-body";
        dialog.append(title, body);
        backdrop.appendChild(dialog);
        backdrop.addEventListener("mousedown", event => {
            if (event.target === backdrop) this.closeOverlayDialog();
        });

        this.overlay.appendChild(backdrop);
        this.activeDialog = backdrop;
        return backdrop;
    }

    addDialogButtons(backdrop, confirmText, danger, onConfirm) {
        const dialog = backdrop.querySelector(".gf-dialog");
        const footer = document.createElement("div");
        footer.className = "gf-dialog-footer";

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "gf-dialog-button gf-dialog-cancel";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => this.closeOverlayDialog());

        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = `gf-dialog-button gf-dialog-confirm${danger ? " gf-dialog-danger" : ""}`;
        confirm.textContent = confirmText;
        confirm.addEventListener("click", onConfirm);

        footer.append(cancel, confirm);
        dialog.appendChild(footer);
    }

    closeOverlayDialog() {
        this.activeDialog?.remove();
        this.activeDialog = null;
        this.dialogOpen = false;
    }

    addStyles() {
        this.api.DOM.addStyle(this.styleId, `
            .gf-home-tile {
                overflow: hidden !important;
                background: linear-gradient(135deg, var(--brand-500, #5865f2), #292d52) !important;
            }

            .gf-floating-tile {
                position: fixed !important;
                z-index: 10000 !important;
                display: block;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                border-radius: 8px;
                font: inherit;
                color: var(--text-default, var(--text-normal, #fff)) !important;
                box-shadow: none !important;
                pointer-events: none !important;
            }

            .gf-home-tile-inner {
                width: 100%;
                height: 100%;
                min-height: 120px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 9px;
                color: inherit;
                font-size: 18px;
                font-weight: 700;
                user-select: none;
            }

            .gf-home-tile-inner svg {
                width: 25px;
                height: 25px;
                flex: 0 0 auto;
            }

            .gf-overlay {
                position: absolute !important;
                right: auto !important;
                bottom: auto !important;
                z-index: 20;
                background: var(--background-base-lowest, var(--background-primary));
                color: var(--text-default, var(--text-normal, #fff));
                overflow: hidden;
                border: 1px solid var(--border-subtle, rgba(255,255,255,.06));
                border-radius: 8px;
                box-sizing: border-box;
                box-shadow: 0 8px 24px rgba(0,0,0,.24);
            }

            .gf-layout {
                width: 100%;
                height: 100%;
                display: grid;
                grid-template-columns: minmax(0, 1fr) 176px;
                min-height: 0;
            }

            .gf-main {
                min-width: 0;
                min-height: 0;
                display: flex;
                flex-direction: column;
                background: var(--background-base-lowest, var(--background-primary));
            }

            .gf-main-header {
                min-height: 58px;
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px 10px;
                border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,.06));
                flex: 0 0 auto;
            }

            .gf-heading-wrap {
                min-width: 0;
            }

            .gf-title {
                font-size: 16px;
                font-weight: 700;
                line-height: 20px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .gf-subtitle {
                margin-top: 1px;
                color: var(--text-muted);
                font-size: 12px;
                line-height: 16px;
            }

            .gf-back-button {
                flex: 0 0 auto;
            }

            .gf-gif-grid {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                grid-auto-rows: 154px;
                gap: 8px;
                padding: 8px;
                align-content: start;
                scrollbar-width: thin;
            }

            .gf-gif-card {
                position: relative;
                border: 0;
                border-radius: 8px;
                padding: 0;
                margin: 0;
                overflow: hidden;
                background: var(--background-surface-high, var(--background-secondary));
                cursor: grab;
                transition: transform .12s ease, opacity .12s ease, box-shadow .12s ease;
                min-width: 0;
                touch-action: none;
                user-select: none;
            }

            .gf-gif-card:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 14px rgba(0,0,0,.22);
            }

            .gf-gif-card:active {
                cursor: grabbing;
            }

            .gf-gif-card.gf-dragging {
                opacity: .45;
                transform: scale(.98);
            }

            .gf-gif-card.gf-reorder-target::after {
                content: "";
                position: absolute;
                inset: 0;
                z-index: 2;
                border: 3px solid var(--brand-500, #5865f2);
                border-radius: 8px;
                box-sizing: border-box;
                pointer-events: none;
            }

            .gf-drag-ghost {
                position: fixed;
                z-index: 10004;
                width: 108px;
                height: 82px;
                overflow: hidden;
                border: 2px solid var(--brand-500, #5865f2);
                border-radius: 8px;
                background: var(--background-surface-high, #202225);
                box-shadow: 0 10px 24px rgba(0,0,0,.38);
                pointer-events: none;
                opacity: .92;
            }

            .gf-drag-ghost img,
            .gf-drag-ghost video {
                width: 100%;
                height: 100%;
                display: block;
                object-fit: cover;
            }

            .gf-gif-card img,
            .gf-gif-card video {
                display: block;
                width: 100%;
                height: 100%;
                object-fit: cover;
                pointer-events: none;
                background: var(--background-surface-high, var(--background-secondary));
            }

            .gf-drag-hint {
                position: absolute;
                right: 6px;
                bottom: 6px;
                padding: 3px 6px;
                border-radius: 5px;
                color: white;
                background: rgba(0,0,0,.58);
                font-size: 10px;
                font-weight: 700;
                opacity: 0;
                transform: translateY(2px);
                transition: opacity .12s ease, transform .12s ease;
                pointer-events: none;
            }

            .gf-gif-card:hover .gf-drag-hint {
                opacity: 1;
                transform: translateY(0);
            }

            .gf-sidebar {
                min-width: 0;
                min-height: 0;
                display: flex;
                flex-direction: column;
                border-left: 1px solid var(--border-subtle, rgba(255,255,255,.06));
                background: var(--background-base-low, var(--background-secondary));
            }

            .gf-sidebar-toolbar {
                min-height: 58px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 8px;
                border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,.06));
            }

            .gf-icon-button {
                width: 32px;
                height: 32px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 0;
                border-radius: 7px;
                background: transparent;
                color: var(--interactive-normal, var(--text-muted));
                cursor: pointer;
            }

            .gf-icon-button:hover:not(:disabled) {
                color: var(--interactive-hover, var(--text-primary));
                background: var(--background-mod-subtle, rgba(255,255,255,.06));
            }

            .gf-icon-button:disabled {
                opacity: .32;
                cursor: not-allowed;
            }

            .gf-icon-button svg {
                width: 19px;
                height: 19px;
            }

            .gf-sidebar-label {
                padding: 10px 10px 5px;
                color: var(--text-muted);
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: .5px;
            }

            .gf-folder-list {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                padding: 3px 6px 8px;
                scrollbar-width: thin;
            }

            .gf-folder {
                width: 100%;
                min-height: 38px;
                border: 1px solid transparent;
                border-radius: 7px;
                padding: 7px 8px;
                margin: 2px 0;
                display: grid;
                grid-template-columns: 20px minmax(0, 1fr) auto;
                align-items: center;
                gap: 7px;
                color: var(--text-secondary, var(--text-normal));
                background: transparent;
                text-align: left;
                cursor: pointer;
                transition: background .1s ease, border-color .1s ease, color .1s ease;
            }

            .gf-folder:hover {
                color: var(--text-primary);
                background: var(--background-mod-subtle, rgba(255,255,255,.05));
            }

            .gf-folder.gf-selected {
                color: var(--text-primary);
                background: var(--background-mod-strong, rgba(255,255,255,.1));
            }

            .gf-folder.gf-drop-target {
                color: var(--text-primary);
                border-color: var(--brand-500);
                background: color-mix(in srgb, var(--brand-500) 18%, transparent);
            }

            .gf-folder-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }

            .gf-folder-icon svg {
                width: 18px;
                height: 18px;
            }

            .gf-folder-name {
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-size: 13px;
                font-weight: 600;
            }

            .gf-folder-count {
                min-width: 20px;
                padding: 1px 5px;
                border-radius: 9px;
                background: var(--background-mod-subtle, rgba(255,255,255,.06));
                color: var(--text-muted);
                font-size: 10px;
                text-align: center;
            }

            .gf-empty {
                grid-column: 1 / -1;
                min-height: 210px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 24px;
                text-align: center;
                color: var(--text-muted);
            }

            .gf-empty-icon {
                margin-bottom: 10px;
                opacity: .7;
            }

            .gf-empty-icon svg {
                width: 40px;
                height: 40px;
            }

            .gf-empty-title {
                color: var(--text-primary);
                font-size: 15px;
                font-weight: 700;
                margin-bottom: 4px;
            }

            .gf-empty-note {
                max-width: 320px;
                font-size: 12px;
                line-height: 17px;
            }

            .gf-dialog-backdrop {
                position: absolute;
                inset: 0;
                z-index: 20;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 16px;
                background: rgba(0,0,0,.64);
                box-sizing: border-box;
            }

            .gf-dialog {
                width: min(330px, 100%);
                overflow: hidden;
                border: 1px solid var(--border-subtle, rgba(255,255,255,.08));
                border-radius: 10px;
                background: var(--background-surface-high, var(--background-secondary));
                box-shadow: 0 14px 36px rgba(0,0,0,.45);
            }

            .gf-dialog-title {
                padding: 16px 16px 0;
                color: var(--text-primary, var(--text-normal));
                font-size: 17px;
                font-weight: 700;
            }

            .gf-dialog-body {
                padding: 14px 16px 16px;
            }

            .gf-dialog-message {
                color: var(--text-secondary, var(--text-normal));
                font-size: 13px;
                line-height: 19px;
            }

            .gf-dialog-input {
                box-sizing: border-box;
                width: 100%;
                height: 38px;
                padding: 8px 10px;
                border: 1px solid var(--input-border, rgba(255,255,255,.12));
                border-radius: 6px;
                outline: none;
                color: var(--text-primary, var(--text-normal));
                background: var(--input-background, var(--background-base-lowest));
                font: inherit;
                font-size: 14px;
            }

            .gf-dialog-input:focus {
                border-color: var(--brand-500, #5865f2);
            }

            .gf-dialog-error {
                min-height: 16px;
                margin-top: 5px;
                color: var(--text-danger, #ed4245);
                font-size: 11px;
                line-height: 16px;
            }

            .gf-dialog-footer {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
                padding: 10px 16px;
                background: var(--background-base-low, var(--background-secondary-alt));
            }

            .gf-dialog-button {
                min-width: 72px;
                height: 34px;
                padding: 0 12px;
                border: 0;
                border-radius: 5px;
                color: white;
                font-weight: 600;
                cursor: pointer;
            }

            .gf-dialog-cancel {
                color: var(--text-secondary, var(--text-normal));
                background: transparent;
            }

            .gf-dialog-cancel:hover {
                color: var(--text-primary, white);
                background: var(--background-mod-subtle, rgba(255,255,255,.06));
            }

            .gf-dialog-confirm {
                background: var(--brand-500, #5865f2);
            }

            .gf-dialog-danger {
                background: var(--status-danger-background, #da373c);
            }

            .gf-dialog-confirm:hover {
                filter: brightness(1.08);
            }

            .gf-settings {
                padding: 6px 2px 18px;
                color: var(--text-primary);
            }

            .gf-settings-title {
                font-size: 20px;
                font-weight: 700;
                margin-bottom: 6px;
            }

            .gf-settings-note {
                color: var(--text-muted);
                font-size: 13px;
                line-height: 18px;
            }

            .gf-settings-row {
                margin-top: 22px;
                padding-top: 16px;
                border-top: 1px solid var(--border-subtle, rgba(255,255,255,.08));
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 24px;
            }

            .gf-settings-row-title {
                margin-bottom: 3px;
                font-size: 15px;
                font-weight: 600;
            }

            .gf-settings-reset {
                min-width: 82px;
                height: 34px;
                padding: 0 14px;
                border: 0;
                border-radius: 4px;
                background: var(--status-danger-background, #da373c);
                color: white;
                font-weight: 600;
                cursor: pointer;
            }

            .gf-settings-reset:hover {
                filter: brightness(1.08);
            }
        `);
    }

    iconBack() {
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.7 5.3a1 1 0 0 1 0 1.4L9.41 12l5.3 5.3a1 1 0 1 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z"/></svg>`;
    }

    iconPlus() {
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5Z"/></svg>`;
    }

    iconEdit() {
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m16.86 3.49 3.65 3.65a1.7 1.7 0 0 1 0 2.4l-9.8 9.8-5.3 1.2a1.5 1.5 0 0 1-1.79-1.8l1.2-5.3 9.8-9.95a1.6 1.6 0 0 1 2.24 0Zm-1.18 2.14-8.98 9.1-.74 3.31 3.3-.75 9.12-8.9-2.7-2.76Z"/></svg>`;
    }

    iconTrash() {
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4a1 1 0 1 1 0 2h-1l-.8 12.1A2 2 0 0 1 16.2 21H7.8a2 2 0 0 1-2-1.9L5 7H4a1 1 0 1 1 0-2h4l1-2Zm-2 4 .8 12h8.4L17 7H7Zm3 3a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1Z"/></svg>`;
    }

    iconFolder(locked) {
        const lock = locked
            ? `<path fill="currentColor" d="M15.8 13.3v-.8a1.8 1.8 0 0 0-3.6 0v.8h-.5v3.8h4.6v-3.8h-.5Zm-2.7-.8a.9.9 0 0 1 1.8 0v.8h-1.8v-.8Z"/>`
            : "";
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Zm10 14H4V8h16v10Z"/>${lock}</svg>`;
    }
};
