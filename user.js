// ==UserScript==
// @name         UESTC学习课程自动播放 by MrCloud
// @namespace    auto-course-player
// @version      1.0.0
// @description  自动识别未完成课程，播放结束后自动切换到下一个
// @match        https://resource.uestc.edu.cn/learn/course/detail/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';



    alert('第一个视频需手动点击播放');


    /******************************************************************
     * 配置
     ******************************************************************/

    const CONFIG = {

        // 初始化等待
        initDelay: 2000,

        // 点击课程后等待
        courseLoadDelay: 2000,

        // 点击下一项以后等待
        nextLoadDelay: 2500,

        // 视频结束后等待服务器保存进度
        finishDelay: 2000,

        // 查找播放器间隔
        playerCheckInterval: 1000,

        // 最多查找播放器次数
        playerMaxChecks: 30,

        // 暂停状态检查间隔
        pauseCheckInterval: 3000,

        // pause 后等待多久再恢复
        pauseResumeDelay: 1200,

        // 视频最后多少秒视为结束
        endThreshold: 0.3,

        // 默认实际播放倍速
        defaultPlaybackRate: 1,

        // 最大倍速
        maxPlaybackRate: 16,

        // 最低倍速
        minPlaybackRate: 0.25,

        // 暂停以后自动继续
        autoResume: true,

        // 播放完成以后自动下一项
        autoNext: true,

        // 控制台日志
        consoleDebug: true,

        // 悬浮窗最大日志数量
        maxLogLines: 150,

        // LearnTime URL 关键词
        learnTimeKeyword: 'learntime',

        // 测试服务器收到的 doubleSpeed
        reportDoubleSpeed: 1
    };


    /******************************************************************
     * 状态
     ******************************************************************/

    let working = false;
    let switching = false;
    let autoResumeBusy = false;

    let currentCourseName = '';

    let playbackRate =
        Number(
            localStorage.getItem(
                'autoCoursePlaybackRate'
            )
        ) || CONFIG.defaultPlaybackRate;

    // 防止保存了大于当前限制的旧数据
    playbackRate = Math.max(
        CONFIG.minPlaybackRate,
        Math.min(
            CONFIG.maxPlaybackRate,
            playbackRate
        )
    );

    let oldUrl = location.href;

    let panel = null;
    let logBox = null;
    let statusText = null;
    let rateInput = null;

    let reportDoubleSpeed =
      Number(
          localStorage.getItem(
              'autoCourseReportDoubleSpeed'
          )
      ) || CONFIG.reportDoubleSpeed;

    /*
     * document.body / 悬浮窗创建前产生的日志
     * 先保存起来。
     */
    const pendingLogs = [];


    /******************************************************************
     * 基础工具
     ******************************************************************/

    function sleep(ms) {
        return new Promise(
            resolve => setTimeout(resolve, ms)
        );
    }


    function getTime() {

        const date = new Date();

        return [
            String(
                date.getHours()
            ).padStart(2, '0'),

            String(
                date.getMinutes()
            ).padStart(2, '0'),

            String(
                date.getSeconds()
            ).padStart(2, '0')

        ].join(':');
    }


    function addLogLine(
        time,
        text
    ) {

        if (!logBox) {
            return;
        }

        const line =
            document.createElement('div');

        line.style.cssText = `
            padding:3px 0;
            border-bottom:1px solid rgba(255,255,255,.06);
            word-break:break-all;
        `;

        line.textContent =
            `[${time}] ${text}`;

        logBox.appendChild(line);


        while (
            logBox.children.length >
            CONFIG.maxLogLines
        ) {
            logBox.removeChild(
                logBox.firstChild
            );
        }


        logBox.scrollTop =
            logBox.scrollHeight;
    }


    function log(...args) {

        const text = args
            .map(item => {

                if (
                    typeof item === 'object'
                ) {

                    try {
                        return JSON.stringify(
                            item
                        );
                    } catch {
                        return String(item);
                    }
                }

                return String(item);
            })
            .join(' ');


        if (
            CONFIG.consoleDebug
        ) {

            console.log(
                '%c[自动学习]',
                'color:#409EFF;font-weight:bold;',
                text
            );
        }


        const time = getTime();


        /*
         * 悬浮窗还没建立
         */
        if (!logBox) {

            pendingLogs.push({
                time,
                text
            });


            if (
                pendingLogs.length >
                CONFIG.maxLogLines
            ) {
                pendingLogs.shift();
            }

            return;
        }


        addLogLine(
            time,
            text
        );
    }


    function flushPendingLogs() {

        if (!logBox) {
            return;
        }


        for (
            const item of pendingLogs
        ) {

            addLogLine(
                item.time,
                item.text
            );
        }

        pendingLogs.length = 0;
    }


    function setStatus(text) {

        if (statusText) {
            statusText.textContent = text;
        }
    }


    /******************************************************************
     * LearnTime body 修改
     ******************************************************************/

    function rewriteLearnTimeBody(
        body
    ) {

        if (
            typeof body !== 'string'
        ) {
            return body;
        }


        try {

            const data =
                JSON.parse(body);


            if (
                data &&
                typeof data ===
                    'object' &&
                'doubleSpeed' in data
            ) {

                const oldValue =
                    data.doubleSpeed;


                data.doubleSpeed =
                    reportDoubleSpeed;


                log(
                  `上传速率已经改为${reportDoubleSpeed}（doubleSpeed: ${oldValue} -> ${reportDoubleSpeed}）`
              );


                return JSON.stringify(
                    data
                );
            }

        } catch (error) {

            log(
                'learntime body 不是 JSON，跳过修改'
            );
        }


        return body;
    }


    /******************************************************************
     * XHR 拦截
     ******************************************************************/

    const rawXhrOpen =
        XMLHttpRequest.prototype.open;

    const rawXhrSend =
        XMLHttpRequest.prototype.send;


    XMLHttpRequest.prototype.open =
        function (
            method,
            url,
            ...rest
        ) {

            this.__courseMethod =
                method;

            this.__courseUrl =
                url;


            return rawXhrOpen.call(
                this,
                method,
                url,
                ...rest
            );
        };


    XMLHttpRequest.prototype.send =
        function (body) {

            const url =
                String(
                    this.__courseUrl ||
                    ''
                );

            const method =
                String(
                    this.__courseMethod ||
                    ''
                ).toUpperCase();


            if (
                method === 'POST' &&
                url.includes(
                    CONFIG.learnTimeKeyword
                )
            ) {

                const newBody =
                    rewriteLearnTimeBody(
                        body
                    );


                log(
                    `XHR 命中 learntime：${url}`
                );


                this.addEventListener(
                    'load',
                    function () {

                        log(
                            `learntime XHR 返回状态：${this.status}`
                        );
                    }
                );


                return rawXhrSend.call(
                    this,
                    newBody
                );
            }


            return rawXhrSend.call(
                this,
                body
            );
        };


    /******************************************************************
     * fetch 拦截
     ******************************************************************/

    const rawFetch =
        window.fetch;


    if (rawFetch) {

        window.fetch =
            function (
                input,
                init = {}
            ) {

                const url =
                    typeof input ===
                    'string'
                        ? input
                        : input?.url || '';


                const method =
                    String(
                        init?.method ||
                        'GET'
                    ).toUpperCase();


                if (
                    method === 'POST' &&
                    String(url).includes(
                        CONFIG.learnTimeKeyword
                    )
                ) {

                    const newInit = {
                        ...init
                    };


                    newInit.body =
                        rewriteLearnTimeBody(
                            init?.body
                        );


                    log(
                        `fetch 命中 learntime：${url}`
                    );


                    return rawFetch.call(
                        this,
                        input,
                        newInit
                    ).then(
                        response => {

                            log(
                                `learntime fetch 返回状态：${response.status}`
                            );

                            return response;
                        }
                    );
                }


                return rawFetch.apply(
                    this,
                    arguments
                );
            };
    }


    /******************************************************************
     * 创建悬浮窗
     ******************************************************************/

    function createFloatingPanel() {

        if (
            document.getElementById(
                'auto-course-panel'
            )
        ) {
            return;
        }


        panel =
            document.createElement(
                'div'
            );


        panel.id =
            'auto-course-panel';


        panel.style.cssText = `
            position:fixed;
            right:18px;
            bottom:18px;
            width:380px;
            background:rgba(20,20,24,.95);
            color:#fff;
            font-family:Arial,"Microsoft YaHei",sans-serif;
            font-size:13px;
            border-radius:10px;
            box-shadow:0 6px 24px rgba(0,0,0,.4);
            z-index:2147483647;
            overflow:hidden;
            border:1px solid rgba(255,255,255,.15);
        `;


        panel.innerHTML = `

            <div
                id="auto-course-header"
                style="
                    padding:10px 12px;
                    background:rgba(64,158,255,.28);
                    font-weight:bold;
                    cursor:move;
                    user-select:none;
                    display:flex;
                    align-items:center;
                    justify-content:space-between;
                "
            >

                <span>
                    课程自动播放助手 by MrCloud
                </span>

                <span
                    id="auto-course-toggle"
                    style="
                        cursor:pointer;
                        font-size:18px;
                        padding:0 5px;
                    "
                >
                    −
                </span>

            </div>


            <div
                id="auto-course-body"
                style="
                    padding:10px;
                "
            >


                <div
                    style="
                        margin-bottom:8px;
                    "
                >

                    状态：

                    <span
                        id="auto-course-status"
                        style="
                            color:#67c23a;
                            font-weight:bold;
                        "
                    >
                        启动中
                    </span>

                </div>


                <div
                    style="
                        display:flex;
                        align-items:center;
                        gap:6px;
                        flex-wrap:wrap;
                        margin-bottom:8px;
                    "
                >

                    <label>
                        倍速：
                    </label>


                    <input
                        id="auto-course-rate"
                        type="number"
                        min="${CONFIG.minPlaybackRate}"
                        max="${CONFIG.maxPlaybackRate}"
                        step="0.25"
                        value="${playbackRate}"
                        style="
                            width:70px;
                            padding:4px 5px;
                            border:1px solid #666;
                            border-radius:4px;
                            background:#222;
                            color:#fff;
                        "
                    >


                    <button
                        id="auto-course-set-rate"
                        style="
                            cursor:pointer;
                            padding:4px 8px;
                        "
                    >
                        设置
                    </button>


                    <button
                        id="auto-course-play"
                        style="
                            cursor:pointer;
                            padding:4px 8px;
                        "
                    >
                        播放
                    </button>


                    <button
                        id="auto-course-next"
                        style="
                            cursor:pointer;
                            padding:4px 8px;
                        "
                    >
                        下一项
                    </button>

                </div>


                <div
                  style="
                      display:flex;
                      align-items:center;
                      gap:6px;
                      flex-wrap:wrap;
                      margin-bottom:8px;
                  "
              >

                  <label>
                      上传服务器的倍速：
                  </label>

                  <input
                      id="auto-course-report-speed"
                      type="number"
                      min="0"
                      step="0.25"
                      value="${reportDoubleSpeed}"
                      style="
                          width:70px;
                          padding:4px 5px;
                          border:1px solid #666;
                          border-radius:4px;
                          background:#222;
                          color:#fff;
                      "
                  >

                  <button
                      id="auto-course-set-report-speed"
                      style="
                          cursor:pointer;
                          padding:4px 8px;
                      "
                  >
                      设置上传值
                  </button>

              </div>


                <div
                    style="
                        display:flex;
                        gap:12px;
                        margin-bottom:8px;
                    "
                >

                    <label>

                        <input
                            id="auto-course-auto-resume"
                            type="checkbox"
                            ${
                                CONFIG.autoResume
                                    ? 'checked'
                                    : ''
                            }
                        >

                        暂停自动继续

                    </label>


                    <label>

                        <input
                            id="auto-course-auto-next"
                            type="checkbox"
                            ${
                                CONFIG.autoNext
                                    ? 'checked'
                                    : ''
                            }
                        >

                        自动下一项

                    </label>

                </div>


                <div
                    style="
                        color:#bbb;
                        margin-bottom:5px;
                    "
                >
                    运行日志
                </div>


                <div
                    id="auto-course-log"
                    style="
                        height:210px;
                        overflow:auto;
                        background:#111;
                        border-radius:5px;
                        padding:7px;
                        font-family:Consolas,monospace;
                        font-size:12px;
                        line-height:1.45;
                    "
                ></div>


                <div
                    style="
                        margin-top:8px;
                    "
                >

                    <button
                        id="auto-course-clear-log"
                        style="
                            cursor:pointer;
                            padding:4px 8px;
                        "
                    >
                        清空日志
                    </button>

                </div>

            </div>
        `;


        document.body.appendChild(
            panel
        );


        logBox =
            document.getElementById(
                'auto-course-log'
            );

        statusText =
            document.getElementById(
                'auto-course-status'
            );

        rateInput =
            document.getElementById(
                'auto-course-rate'
            );


        /*
         * 把悬浮窗建立前的日志补进来
         */
        flushPendingLogs();


        /**************************************************************
         * 设置倍速
         **************************************************************/

        document
            .getElementById(
                'auto-course-set-rate'
            )
            .addEventListener(
                'click',
                () => {

                    let value =
                        Number(
                            rateInput.value
                        );


                    if (
                        !Number.isFinite(
                            value
                        )
                    ) {

                        log(
                            '倍速输入无效'
                        );

                        return;
                    }


                    value =
                        Math.max(
                            CONFIG.minPlaybackRate,
                            Math.min(
                                CONFIG.maxPlaybackRate,
                                value
                            )
                        );


                    playbackRate =
                        value;


                    rateInput.value =
                        String(value);


                    localStorage.setItem(
                        'autoCoursePlaybackRate',
                        String(value)
                    );


                    applyPlaybackRate();


                    log(
                        `实际播放倍速设置为 ${value}x`
                    );
                }
            );
        /**************************************************************
         * 设置上传
         **************************************************************/
        document
        .getElementById(
            'auto-course-set-report-speed'
        )
        .addEventListener(
            'click',
            () => {

                const input =
                    document.getElementById(
                        'auto-course-report-speed'
                    );

                const value =
                    Number(
                        input.value
                    );

                if (
                    !Number.isFinite(value) ||
                    value < 0
                ) {
                    log(
                        '上传 doubleSpeed 输入无效'
                    );

                    return;
                }

                reportDoubleSpeed =
                    value;

                localStorage.setItem(
                    'autoCourseReportDoubleSpeed',
                    String(value)
                );

                log(
                    `上传 doubleSpeed 已设置为：${value}`
                );
            }
        );


        /**************************************************************
         * 手动播放按钮
         **************************************************************/

        document
            .getElementById(
                'auto-course-play'
            )
            .addEventListener(
                'click',
                async () => {

                    log(
                        '手动点击悬浮窗播放按钮'
                    );

                    await resumeVideo();
                }
            );


        /**************************************************************
         * 手动下一项
         **************************************************************/

        document
            .getElementById(
                'auto-course-next'
            )
            .addEventListener(
                'click',
                async () => {

                    log(
                        '手动执行下一学习内容'
                    );

                    await goNextLearningContent();
                }
            );


        /**************************************************************
         * 自动续播开关
         **************************************************************/

        document
            .getElementById(
                'auto-course-auto-resume'
            )
            .addEventListener(
                'change',
                event => {

                    CONFIG.autoResume =
                        event.target.checked;


                    log(
                        `暂停自动继续：${
                            CONFIG.autoResume
                                ? '开启'
                                : '关闭'
                        }`
                    );
                }
            );


        /**************************************************************
         * 自动下一项
         **************************************************************/

        document
            .getElementById(
                'auto-course-auto-next'
            )
            .addEventListener(
                'change',
                event => {

                    CONFIG.autoNext =
                        event.target.checked;


                    log(
                        `自动下一项：${
                            CONFIG.autoNext
                                ? '开启'
                                : '关闭'
                        }`
                    );
                }
            );


        /**************************************************************
         * 清空日志
         **************************************************************/

        document
            .getElementById(
                'auto-course-clear-log'
            )
            .addEventListener(
                'click',
                () => {

                    logBox.innerHTML = '';

                    log(
                        '日志已清空'
                    );
                }
            );


        /**************************************************************
         * 折叠
         **************************************************************/

        const toggle =
            document.getElementById(
                'auto-course-toggle'
            );


        const body =
            document.getElementById(
                'auto-course-body'
            );


        toggle.addEventListener(
            'click',
            event => {

                event.stopPropagation();


                const hidden =
                    body.style.display ===
                    'none';


                body.style.display =
                    hidden
                        ? 'block'
                        : 'none';


                toggle.textContent =
                    hidden
                        ? '−'
                        : '+';
            }
        );


        makePanelDraggable();
    }


    /******************************************************************
     * 悬浮窗拖动
     ******************************************************************/

    function makePanelDraggable() {

        const header =
            document.getElementById(
                'auto-course-header'
            );


        if (
            !header ||
            !panel
        ) {
            return;
        }


        let dragging = false;

        let offsetX = 0;
        let offsetY = 0;


        header.addEventListener(
            'mousedown',
            event => {

                if (
                    event.target.id ===
                    'auto-course-toggle'
                ) {
                    return;
                }


                dragging = true;


                const rect =
                    panel.getBoundingClientRect();


                offsetX =
                    event.clientX -
                    rect.left;

                offsetY =
                    event.clientY -
                    rect.top;


                panel.style.right =
                    'auto';

                panel.style.bottom =
                    'auto';
            }
        );


        document.addEventListener(
            'mousemove',
            event => {

                if (!dragging) {
                    return;
                }


                panel.style.left =
                    `${
                        event.clientX -
                        offsetX
                    }px`;


                panel.style.top =
                    `${
                        event.clientY -
                        offsetY
                    }px`;
            }
        );


        document.addEventListener(
            'mouseup',
            () => {

                dragging = false;
            }
        );
    }


    /******************************************************************
     * 页面判断
     ******************************************************************/

    function isCoursePage() {

        return (
            location.pathname
                .startsWith(
                    '/learn/course'
                )
        );
    }


    /******************************************************************
     * 课程列表
     ******************************************************************/

    function getCourseNodes() {

        return [
            ...document.querySelectorAll(
                '.chapter_tree_node .section_item'
            )
        ];
    }


    function getCourseName(
        node
    ) {

        const element =
            node.querySelector(
                '.course_name'
            );


        if (!element) {
            return '未知课程';
        }


        return element
            .textContent
            .trim()
            .replace(
                /\s+/g,
                ' '
            );
    }


    /******************************************************************
     * 课程是否完成
     ******************************************************************/

    function isFinished(
        node
    ) {

        /*
         * 完成图标
         */
        if (
            node.querySelector(
                '.progress .progress_icon.full'
            )
        ) {
            return true;
        }


        /*
         * ElementUI progress
         */
        const progress =
            node.querySelector(
                '[role="progressbar"][aria-valuenow]'
            );


        if (progress) {

            const value =
                Number(
                    progress.getAttribute(
                        'aria-valuenow'
                    )
                );


            if (
                value >= 100
            ) {
                return true;
            }
        }


        return false;
    }


    function getProgress(
        node
    ) {

        if (
            isFinished(node)
        ) {
            return 100;
        }


        const progress =
            node.querySelector(
                '[role="progressbar"][aria-valuenow]'
            );


        if (!progress) {
            return 0;
        }


        return (
            Number(
                progress.getAttribute(
                    'aria-valuenow'
                )
            ) || 0
        );
    }


    function findNextUnfinishedCourse() {

        const courses =
            getCourseNodes();


        log(
            `扫描课程，共发现 ${courses.length} 项`
        );


        for (
            let i = 0;
            i < courses.length;
            i++
        ) {

            const course =
                courses[i];


            const name =
                getCourseName(
                    course
                );


            const progress =
                getProgress(
                    course
                );


            log(
                `${i + 1}/${courses.length}`,
                name,
                `进度 ${progress}%`
            );


            if (
                !isFinished(
                    course
                )
            ) {

                log(
                    `找到未完成课程：${name}`
                );

                return course;
            }
        }


        return null;
    }


    /******************************************************************
     * 获取播放器
     ******************************************************************/

    function getPlayer() {

        return (
            document.querySelector(
                'xg-player'
            ) ||

            document.querySelector(
                '.xgplayer'
            )
        );
    }


    function getVideo() {

        const player =
            getPlayer();


        if (player) {

            const video =
                player.querySelector(
                    'video'
                );


            if (video) {
                return video;
            }
        }


        return document.querySelector(
            'video'
        );
    }


    /******************************************************************
     * 初始播放按钮
     ******************************************************************/

    function getStartButton() {

        const player =
            getPlayer();


        if (!player) {
            return null;
        }


        return (
            player.querySelector(
                'xg-start.xgplayer-start'
            ) ||

            player.querySelector(
                '.xgplayer-start'
            )
        );
    }


    /******************************************************************
     * 播放 / 暂停控制按钮
     *
     * 对应：
     *
     * <xg-icon class="xgplayer-icon">
     ******************************************************************/

    function getPlayPauseButton() {

        const player =
            getPlayer();


        if (!player) {
            return null;
        }


        const buttons = [
            ...player.querySelectorAll(
                'xg-icon.xgplayer-icon'
            )
        ];


        for (
            const button of buttons
        ) {

            if (
                button.querySelector(
                    '.xgplayer-icon-play'
                ) &&
                button.querySelector(
                    '.xgplayer-icon-pause'
                )
            ) {

                return button;
            }
        }


        return null;
    }


    /******************************************************************
     * 下一个学习内容
     ******************************************************************/

    function getNextButton() {

        const button =
            document.querySelector(
                '.video_btn.next_video_btn'
            );


        if (!button) {
            return null;
        }


        const style =
            getComputedStyle(
                button
            );


        if (
            style.display === 'none' ||
            style.visibility ===
                'hidden' ||
            style.pointerEvents ===
                'none'
        ) {

            return null;
        }


        if (
            button.classList.contains(
                'disabled'
            )
        ) {
            return null;
        }


        return button;
    }


    /******************************************************************
     * 应用实际播放倍速
     ******************************************************************/

    function applyPlaybackRate(
        video = getVideo()
    ) {

        if (!video) {
            return false;
        }


        try {

            video.playbackRate =
                playbackRate;

            video.defaultPlaybackRate =
                playbackRate;


            log(
                `已应用实际播放倍速：${playbackRate}x`
            );


            return true;

        } catch (error) {

            log(
                '设置倍速失败：',
                error
            );


            return false;
        }
    }


    /******************************************************************
     * 恢复播放
     ******************************************************************/

    async function resumeVideo() {

        const video =
            getVideo();


        if (!video) {

            log(
                '恢复播放失败：没有找到 video'
            );

            return false;
        }


        if (
            video.ended
        ) {

            log(
                '视频已经结束，不执行恢复播放'
            );

            return false;
        }


        applyPlaybackRate(
            video
        );


        /*
         * 已经播放
         */
        if (
            !video.paused
        ) {

            log(
                '视频已经处于播放状态'
            );

            return true;
        }


        /*
         * 已经播放过的视频：
         *
         * 点击正常播放 / 暂停按钮
         */
        if (
            video.currentTime > 0
        ) {

            const control =
                getPlayPauseButton();


            if (control) {

                log(
                    '点击 xgplayer 播放/暂停按钮恢复播放'
                );


                control.click();


                await sleep(600);


                if (
                    !video.paused
                ) {

                    applyPlaybackRate(
                        video
                    );

                    return true;
                }
            }
        }


        /*
         * 第一次启动：
         *
         * 尝试初始大按钮
         */
        if (
            video.currentTime <= 0
        ) {

            const start =
                getStartButton();


            if (start) {

                log(
                    '尝试点击播放器初始播放按钮'
                );


                start.click();


                await sleep(600);


                if (
                    !video.paused
                ) {

                    applyPlaybackRate(
                        video
                    );

                    return true;
                }
            }
        }


        /*
         * 最后使用 HTML5 play() 兜底
         */
        try {

            log(
                '尝试使用 video.play() 播放'
            );


            await video.play();


            applyPlaybackRate(
                video
            );


            return true;

        } catch (error) {

            log(
                '自动播放失败，可能需要手动点击第一个视频'
            );


            return false;
        }
    }


    /******************************************************************
     * 自动恢复暂停
     ******************************************************************/

    async function autoResumeIfPaused() {

        if (
            !CONFIG.autoResume ||
            autoResumeBusy ||
            switching
        ) {
            return;
        }


        const video =
            getVideo();


        if (!video) {
            return;
        }


        if (
            video.ended ||
            video.dataset
                .autoCourseEnding ===
                '1'
        ) {
            return;
        }


        if (
            video.readyState < 2
        ) {
            return;
        }


        if (
            !video.paused
        ) {
            return;
        }


        /*
         * 0 秒表示可能还是第一个视频尚未启动，
         * 不作为中途暂停处理。
         */
        if (
            video.currentTime <= 0
        ) {
            return;
        }


        autoResumeBusy =
            true;


        log(
            `检测到暂停，当前位置 ${video.currentTime.toFixed(1)} 秒`
        );


        await resumeVideo();


        autoResumeBusy =
            false;
    }


    /******************************************************************
     * 等待播放器
     ******************************************************************/

    async function tryStartVideo() {

        setStatus(
            '等待播放器'
        );


        log(
            '等待播放器加载...'
        );


        for (
            let i = 0;
            i <
                CONFIG.playerMaxChecks;
            i++
        ) {

            const video =
                getVideo();


            if (video) {

                log(
                    '已检测到 video 元素'
                );


                attachVideoEvents(
                    video
                );


                applyPlaybackRate(
                    video
                );


                if (
                    !video.paused &&
                    !video.ended
                ) {

                    setStatus(
                        `播放中 ${playbackRate}x`
                    );

                    return true;
                }


                const success =
                    await resumeVideo();


                if (success) {

                    setStatus(
                        `播放中 ${playbackRate}x`
                    );

                    return true;
                }
            }


            await sleep(
                CONFIG.playerCheckInterval
            );
        }


        setStatus(
            '需要手动播放'
        );


        log(
            '自动播放没有成功，请手动点击一次第一个视频'
        );


        return false;
    }


    /******************************************************************
     * 打开课程
     ******************************************************************/

    async function openCourse(
        course
    ) {

        if (!course) {
            return false;
        }


        currentCourseName =
            getCourseName(
                course
            );


        setStatus(
            '正在进入课程'
        );


        log(
            `准备进入课程：${currentCourseName}`
        );


        course.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });


        await sleep(500);


        course.click();


        log(
            '已点击课程节点'
        );


        await sleep(
            CONFIG.courseLoadDelay
        );


        return await tryStartVideo();
    }


    /******************************************************************
     * 视频结束
     ******************************************************************/

    async function handleVideoFinished(
        video
    ) {

        /*
         * ended 和 timeupdate
         * 可能同时触发。
         */
        if (
            video.dataset
                .autoCourseEnding ===
                '1'
        ) {
            return;
        }


        video.dataset.autoCourseEnding =
            '1';


        if (switching) {
            return;
        }


        switching = true;


        setStatus(
            '视频已结束'
        );


        log(
            `视频播放完成：${
                currentCourseName ||
                '当前学习内容'
            }`
        );


        await sleep(
            CONFIG.finishDelay
        );


        if (
            CONFIG.autoNext
        ) {

            await goNextLearningContent();

        } else {

            setStatus(
                '等待操作'
            );


            log(
                '自动下一项已关闭'
            );
        }


        switching = false;
    }


    /******************************************************************
     * 下一学习内容
     ******************************************************************/

    async function goNextLearningContent() {

        const nextButton =
            getNextButton();


        if (nextButton) {

            log(
                '找到「下一个学习内容」按钮'
            );


            setStatus(
                '切换下一项'
            );


            nextButton.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });


            await sleep(300);


            nextButton.click();


            log(
                '已点击「下一个学习内容」'
            );


            await sleep(
                CONFIG.nextLoadDelay
            );


            const success =
                await tryStartVideo();


            if (success) {

                log(
                    '下一项已经开始播放'
                );

                return true;
            }


            log(
                '点击下一项后没有正常启动播放器'
            );
        }


        /*
         * 找不到下一按钮：
         *
         * 回课程列表扫描。
         */
        log(
            '未找到可用的下一项按钮，重新扫描课程'
        );


        working = false;


        await sleep(1000);


        await playNextCourse();


        return false;
    }


    /******************************************************************
     * 给 video 绑定事件
     ******************************************************************/

    function attachVideoEvents(
        video
    ) {

        if (!video) {
            return;
        }


        /*
         * 防止重复绑定
         */
        if (
            video.dataset
                .autoCourseBound ===
                '1'
        ) {
            return;
        }


        video.dataset.autoCourseBound =
            '1';

        video.dataset.autoCourseEnding =
            '0';


        log(
            '绑定 video 播放事件'
        );


        /**************************************************************
         * 视频元信息
         **************************************************************/

        video.addEventListener(
            'loadedmetadata',
            () => {

                log(
                    `视频时长：${
                        Number.isFinite(
                            video.duration
                        )
                            ? video.duration
                                .toFixed(1)
                            : '?'
                    } 秒`
                );


                applyPlaybackRate(
                    video
                );
            }
        );


        /**************************************************************
         * 可播放
         **************************************************************/

        video.addEventListener(
            'canplay',
            () => {

                applyPlaybackRate(
                    video
                );
            }
        );


        /**************************************************************
         * 倍速被播放器修改
         **************************************************************/

        video.addEventListener(
            'ratechange',
            () => {

                if (
                    Math.abs(
                        video.playbackRate -
                        playbackRate
                    ) > 0.01
                ) {

                    log(
                        `播放器把实际倍速改成 ${video.playbackRate}x，准备恢复 ${playbackRate}x`
                    );


                    setTimeout(
                        () => {

                            if (
                                getVideo() ===
                                video
                            ) {

                                try {

                                    video.playbackRate =
                                        playbackRate;

                                } catch (
                                    error
                                ) {
                                    // ignore
                                }
                            }

                        },
                        100
                    );
                }
            }
        );


        /**************************************************************
         * 开始播放
         **************************************************************/

        video.addEventListener(
            'play',
            () => {

                video.dataset
                    .autoCourseEnding =
                    '0';


                applyPlaybackRate(
                    video
                );


                setStatus(
                    `播放中 ${playbackRate}x`
                );


                log(
                    `开始播放，当前位置 ${video.currentTime.toFixed(1)} 秒`
                );
            }
        );


        /**************************************************************
         * 暂停
         **************************************************************/

        video.addEventListener(
            'pause',
            async () => {

                if (
                    video.ended ||
                    video.dataset
                        .autoCourseEnding ===
                        '1'
                ) {
                    return;
                }


                setStatus(
                    '检测到暂停'
                );


                log(
                    `收到 pause 事件，当前位置 ${video.currentTime.toFixed(1)} 秒`
                );


                if (
                    !CONFIG.autoResume
                ) {
                    return;
                }


                await sleep(
                    CONFIG.pauseResumeDelay
                );


                if (
                    video.paused &&
                    !video.ended
                ) {

                    await autoResumeIfPaused();
                }
            }
        );


        /**************************************************************
         * 正常播放结束
         **************************************************************/

        video.addEventListener(
            'ended',
            async () => {

                log(
                    '收到 ended 事件'
                );


                await handleVideoFinished(
                    video
                );
            }
        );


        /**************************************************************
         * timeupdate 结束保险
         **************************************************************/

        video.addEventListener(
            'timeupdate',
            async () => {

                if (
                    !video.duration ||
                    !Number.isFinite(
                        video.duration
                    )
                ) {
                    return;
                }


                if (
                    video.currentTime <= 0
                ) {
                    return;
                }


                const remaining =
                    video.duration -
                    video.currentTime;


                if (
                    remaining <=
                    CONFIG.endThreshold
                ) {

                    await handleVideoFinished(
                        video
                    );
                }
            }
        );


        /**************************************************************
         * 播放错误
         **************************************************************/

        video.addEventListener(
            'error',
            () => {

                setStatus(
                    '播放器错误'
                );


                log(
                    'video 播放错误',
                    video.error || ''
                );
            }
        );
    }


    /******************************************************************
     * 扫描课程
     ******************************************************************/

    async function playNextCourse() {

        if (working) {
            return;
        }


        if (
            !isCoursePage()
        ) {
            return;
        }


        working = true;


        setStatus(
            '扫描课程'
        );


        log(
            '开始扫描未完成课程'
        );


        await sleep(1000);


        const nextCourse =
            findNextUnfinishedCourse();


        if (!nextCourse) {

            setStatus(
                '全部完成'
            );


            log(
                '没有发现未完成课程'
            );


            working = false;

            return;
        }


        const success =
            await openCourse(
                nextCourse
            );


        if (!success) {

            /*
             * 第一个视频可能因为浏览器
             * 自动播放限制无法启动。
             *
             * 这里不继续乱点，
             * 用户可以自己手动点击一次。
             */
            setStatus(
                '等待手动播放'
            );


            log(
                '如果这是第一个视频，请手动点击一次播放按钮'
            );
        }


        working = false;
    }


    /******************************************************************
     * MutationObserver
     *
     * Vue / SPA 创建新 video 后自动绑定
     ******************************************************************/

    const observer =
        new MutationObserver(
            () => {

                const video =
                    getVideo();


                if (!video) {
                    return;
                }


                if (
                    video.dataset
                        .autoCourseBound !==
                        '1'
                ) {

                    log(
                        '检测到新的 video'
                    );


                    attachVideoEvents(
                        video
                    );


                    applyPlaybackRate(
                        video
                    );
                }
            }
        );


    /******************************************************************
     * 定时检测暂停
     ******************************************************************/

    setInterval(
        async () => {

            if (
                !CONFIG.autoResume
            ) {
                return;
            }


            const video =
                getVideo();


            if (!video) {
                return;
            }


            if (
                video.currentTime > 0 &&
                video.paused &&
                !video.ended &&
                video.dataset
                    .autoCourseEnding !==
                    '1'
            ) {

                await autoResumeIfPaused();
            }

        },
        CONFIG.pauseCheckInterval
    );


    /******************************************************************
     * SPA URL 变化
     ******************************************************************/

    setInterval(
        async () => {

            if (
                location.href ===
                oldUrl
            ) {
                return;
            }


            oldUrl =
                location.href;


            log(
                `检测到 URL 变化：${oldUrl}`
            );


            await sleep(800);


            const video =
                getVideo();


            if (video) {

                attachVideoEvents(
                    video
                );


                applyPlaybackRate(
                    video
                );
            }

        },
        1000
    );


    /******************************************************************
     * 初始化
     ******************************************************************/

    async function init() {

        /*
         * 因为使用 document-start，
         * 等待 body 出现。
         */
        while (
            !document.body
        ) {
            await sleep(50);
        }


        createFloatingPanel();


        log(
            '=============================='
        );


        log(
            '课程自动播放助手 V4 已启动'
        );


        log(
            `当前实际播放倍速：${playbackRate}x`
        );


        log(
            `learntime 上传 doubleSpeed 当前值：${reportDoubleSpeed}`
        );


        log(
            '第一个视频如果无法自动播放，请手动点击一次'
        );


        log(
            '=============================='
        );


        setStatus(
            '初始化'
        );


        if (
            !isCoursePage()
        ) {

            setStatus(
                '非课程页面'
            );


            log(
                '当前不是课程页面'
            );


            return;
        }


        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );


        await sleep(
            CONFIG.initDelay
        );


        /*
         * 页面已经存在播放器
         */
        const existingVideo =
            getVideo();


        if (existingVideo) {

            log(
                '页面已经存在播放器'
            );


            attachVideoEvents(
                existingVideo
            );


            applyPlaybackRate(
                existingVideo
            );


            await tryStartVideo();


            return;
        }


        /*
         * 没有播放器：
         *
         * 扫描第一个未完成课程
         */
        await playNextCourse();
    }


    init();

})();
