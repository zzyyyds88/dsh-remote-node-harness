/**
 * Browser half of `@greatbaby/dsh-remote-node-harness`.
 *
 * It adds two surfaces and nothing else:
 *
 * - **Settings › Remote nodes** — a full section page that lists this machine and
 *   every configured remote node, and owns the add/edit form.
 * - **A Remote nodes panel** — a sidebar panel icon plus its main-column page, so
 *   the node list is reachable without opening Settings.
 *
 * What it deliberately does *not* do is present remote machines as separate
 * places to visit. A connected node's workspaces and sessions are merged into the
 * ordinary sidebar by the Host half, so opening a remote project is the same
 * gesture as opening a local one. This surface only manages the connections.
 *
 * @module @greatbaby/dsh-remote-node-harness/client
 */
window.__ModuleLoader__.load({
  // DSH requires this id to equal the package name: the module table is keyed by it.
  id: '@greatbaby/dsh-remote-node-harness',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    // The shipped control set, resolved through the shell's module table rather
    // than imported: this package has no build step and no dependency on the UI
    // packages. Using it is what makes a dialog here behave like the shipped one
    // (the same button heights, the same focus ring, the same modal chrome).
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, StateDot,
      IconChevronLeftOutlineRegular,
      IconChevronRightOutlineRegular,
      IconChevronsUpDownOutlineRegular,
      IconFolderCloseRegular,
      IconPlusOutlineRegular,
    } = ui

    /** Where the Host half answers management calls. */
    const API = 'rnh/api'

    /** Bilingual copy chosen once from the document language. */
    const zh = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase().startsWith('zh')
    const T = zh
      ? {
          title: '远程节点',
          sectionTitle: '远程节点',
          subtitle: '在另一台机器上运行 DeepSeek Harness。已连接节点的工作区会直接出现在侧栏里。',
          local: '本机',
          localHint: '你正在使用的这一个 Harness。它的会话、工作区与工具都留在本地。',
          remote: '远程',
          remoteHint: '每个节点运行自己的 Harness。会话、文件与工具执行都在那台机器上。',
          add: '添加节点',
          edit: '编辑',
          remove: '移除',
          cancel: '取消',
          save: '保存',
          connect: '连接',
          disconnect: '断开',
          retry: '重试',
          connecting: '连接中',
          connected: '已连接',
          idle: '未连接',
          failed: '连接失败',
          name: '名称',
          host: '主机',
          port: '端口',
          username: '用户名',
          auth: '认证方式',
          password: '密码',
          privateKey: '私钥',
          privateKeyHint: '粘贴 OpenSSH 私钥，以 -----BEGIN 开头。',
          passphrase: '私钥口令（可选）',
          advanced: '高级选项',
          remoteRoot: '远端安装目录',
          autoConnect: '应用启动时自动连接',
          empty: '还没有远程节点。点「添加节点」接入一台机器。',
          searchNodes: '按名字、用户或地址搜索',
          searchEmpty: '没有匹配的节点。',
          errorTitle: '无法连接',
          removeConfirm: '移除这个节点？它在那台机器上的会话不会被删除。',
          workspaces: '工作区',
          workspacesHint: '已连接的节点把它自己的工作区并入左侧列表，不需要单独打开。',
          noWorkspaces: '这个节点还没有工作区。在下面填一个它上面的绝对路径即可加入。',
          addWorkspace: '加入工作区',
          pathPlaceholder: '这个节点上的绝对路径，例如 /root/project',
          phases: {
            probe: '正在识别远端环境',
            install: '正在安装远端 Harness',
            build: '正在由节点自行构建运行时',
            provision: '正在下发模型与凭据',
            start: '正在启动远端服务',
            verify: '正在验证远端会话通道',
          },
          /** How a node's runtime arrived. Shown only when the Host reported it. */
          runtimeVia: {
            artefact: '运行时来源：下载的制品',
            npm: '运行时来源：旧版节点自建（重连会换成制品）',
          },
          missingSecret: '还没有保存密码或私钥。',
          /** Why a connect failed, as one sentence plus the one action worth offering. */
          failures: {
            'ssh-auth': '那台机器拒绝了这个节点的凭据。',
            'ssh-host-key': '那台机器出示的 SSH 主机密钥和记录的不一致。',
            'ssh-timeout': '那台机器没有在超时前应答。',
            'ssh-network': '连不上那台机器。',
            'ssh-closed': '和那台机器的连接被关闭了。',
            'credential-missing': '这个节点还没有保存凭据。',
            'node-too-old': '那台机器的 Node.js 版本太旧。',
            'runtime-install': '节点运行时装不上。',
            'node-ahead': '节点上的 DSH 比这个桌面端更新。',
            'node-unknown-version': '读不出节点上装的版本。',
            provision: '写不进节点的配置。',
            'host-start': '常驻服务没有起来。',
            'host-verify': '常驻服务起来了，但会话通道没有应答。',
            unknown: '这个节点连不上。',
          },
          actions: {
            'fix-credential': '修改凭据',
            'review-host-key': '查看主机密钥',
            'check-network': '检查网络',
            retry: '重试',
            'upgrade-node': '升级节点的 Node.js',
            'upgrade-desktop': '升级桌面端',
            reinstall: '重装运行时',
            'inspect-log': '查看连接日志',
          },
          retrying: '重试中',
          dropped: '已断线，正在重连',
          droppedAt: when => `已断线，正在重连（${when} 断开）`,
          recovered: count => `已重连 ${count} 次`,
          /** Which rung of the ladder this is. Past the ladder it is a steady retry. */
          recoveryAttempt: (attempt, ladder) => (attempt <= ladder
            ? `第 ${attempt}/${ladder} 次`
            : '每 2 分钟重试一次'),
          /** How long the current phase has been running. */
          phasesElapsed: seconds => `已用 ${seconds} 秒`,
          /** Live download progress; each fragment is dropped when its number is unknown. */
          transfer: ({ bytes, total, bytesPerSecond, etaMs }) => {
            const size = value => `${(value / 1048576).toFixed(1)} MiB`
            const parts = [total === undefined ? size(bytes) : `${size(bytes)} / ${size(total)}`]
            if (bytesPerSecond !== undefined) parts.push(`${(bytesPerSecond / 1048576).toFixed(1)} MB/s`)
            if (etaMs !== undefined) parts.push(`剩余 ${String(Math.max(1, Math.round(etaMs / 1000)))} 秒`)
            return parts.join(' · ')
          },
          /** The action verbs that are their own button, rather than "open the log". */
          resetHostKey: '重置主机密钥',
          reprobe: '重新探测',
          copyError: '复制错误',
          errorCopied: '已复制',
          reveal: '显示',
          hide: '隐藏',
          hostKey: key => `主机密钥 ${key}`,
          showLog: '连接日志',
          logEmpty: '还没有日志。',
          copyLog: '复制',
          logCopied: '已复制',
          logHint: '最近 100 行，密码、令牌与私钥已抹掉。',
          plugins: '插件同步',
          pluginsHint: '这里列出的是你自己装到这个桌面端的第三方插件，默认全部下发：装在这里、连了节点，就是同一个工作环境，而不是两台各跑一套的机器。关掉一个就只在这台机器上运行。中转插件与这个插件自身永远不会下发，因为节点再去控制别的节点、或者自己开一个入口，都不是要的东西。改动立即下发到已连接的节点，节点会在需要时重启常驻进程。',
          pluginLoaded: '本机已加载',
          pluginInstalledOnly: '本机已安装，但不在这台机器的组合里',
          pluginRows: rows => `${rows} 行`,
          pluginApplied: '已下发',
          pluginNodeFailed: '节点未接受',
          pluginNoNodes: '还没有连接任何节点；开关会记住，连接时生效',
          pluginsNone: '这台机器上没有装第三方插件。装了之后会自动下发到节点，也可以在这里逐个关掉。',
          pluginFailed: '插件列表还没准备好',
          pluginOnHint: '已下发到这个节点',
          pluginOffHint: '只在这台机器上运行',
          pickFolder: '选择工作区文件夹',
          machine: '在哪台机器上',
          chooseDevice: '选择设备',
          thisDevice: '此设备',
          deviceHint: '工作区所在的机器',
          switchDevice: '更换',
          drivesHere: '盘符',
          nodeRootHint: '节点根目录',
          browseAnywhere: '浏览全部目录',
          up: '上一级',
          go: '打开',
          loading: '正在读取…',
          noFolders: '这个目录下没有子文件夹。',
          noFoldersYet: '这台机器上还没有这个目录。选「选择此文件夹」就会在它上面建出来。',
          truncated: '只显示前 500 个文件夹；可以直接在上面输入完整路径。',
          newFolder: '新建文件夹',
          newFolderTitle: '新建文件夹',
          newFolderName: '文件夹名称',
          newFolderPlaceholder: '例如 my-project',
          newFolderCreate: '创建',
          newFolderFailed: '新建文件夹失败',
          drives: '磁盘',
          workspaceName: '工作区名称',
          workspaceNamePlaceholder: '留空则用文件夹名',
          createProject: '创建项目',
          projectName: '项目名称',
          projectNamePlaceholder: '新项目',
          device: '设备',
          addRemoteDevice: '添加远程设备…',
          sourceFolder: '源文件夹',
          chooseFolder: '选择文件夹',
          lastUsed: '上次使用',
          chooseFolderHint: 'Harness 可以读取和编辑这些文件夹',
          changeFolder: '更换',
          pickThisFolder: '选择此文件夹',
          back: '返回',
          create: '创建',
          existingOnDeviceHint: '这台设备上已有项目？',
          existingOnDeviceAction: '添加到侧栏',
          existingEmpty: '这台设备上还没有工作区。',
        }
      : {
          title: 'Remote nodes',
          sectionTitle: 'Remote nodes',
          subtitle: 'Run DeepSeek Harness on another machine. A connected node\'s workspaces appear in the sidebar itself.',
          local: 'This machine',
          localHint: 'The Harness you are using right now. Its sessions, workspaces and tools stay local.',
          remote: 'Remote',
          remoteHint: 'Each node runs its own Harness. Its sessions, files and tool execution live on that machine.',
          add: 'Add node',
          edit: 'Edit',
          remove: 'Remove',
          cancel: 'Cancel',
          save: 'Save',
          connect: 'Connect',
          disconnect: 'Disconnect',
          retry: 'Retry',
          connecting: 'Connecting',
          connected: 'Connected',
          idle: 'Not connected',
          failed: 'Connection failed',
          name: 'Name',
          host: 'Host',
          port: 'Port',
          username: 'Username',
          auth: 'Authentication',
          password: 'Password',
          privateKey: 'Private key',
          privateKeyHint: 'Paste the OpenSSH private key, beginning with -----BEGIN.',
          passphrase: 'Passphrase (optional)',
          advanced: 'Advanced options',
          remoteRoot: 'Remote install directory',
          autoConnect: 'Connect automatically when the app starts',
          empty: 'No remote nodes yet. Add one to connect a machine.',
          searchNodes: 'Search by name, user or address',
          searchEmpty: 'No node matches.',
          errorTitle: 'Could not connect',
          removeConfirm: 'Remove this node? Its sessions on the remote machine are not deleted.',
          workspaces: 'Workspaces',
          workspacesHint: 'A connected node merges its own workspaces into the left list; there is nothing to open separately.',
          noWorkspaces: 'This node has no workspaces yet. Enter an absolute path on it below to add one.',
          addWorkspace: 'Add workspace',
          pathPlaceholder: 'An absolute path on this node, e.g. /root/project',
          phases: {
            probe: 'Identifying the remote environment',
            install: 'Installing the remote Harness',
            build: 'Building the runtime on the node',
            provision: 'Sending models and credentials',
            start: 'Starting the remote service',
            verify: 'Verifying the remote session channel',
          },
          /** How a node's runtime arrived. Shown only when the Host reported it. */
          runtimeVia: {
            artefact: 'Runtime: downloaded artefact',
            npm: 'Runtime: built on the node by an older plugin (a reconnect replaces it)',
          },
          missingSecret: 'No password or private key is stored yet.',
          /** Why a connect failed, as one sentence plus the one action worth offering. */
          failures: {
            'ssh-auth': 'The machine refused this node\'s credential.',
            'ssh-host-key': 'The machine presented a different SSH host key than the one recorded for it.',
            'ssh-timeout': 'The machine did not answer in time.',
            'ssh-network': 'The machine could not be reached.',
            'ssh-closed': 'The connection to the machine was closed.',
            'credential-missing': 'This node has no stored credential yet.',
            'node-too-old': 'The machine\'s Node.js is too old.',
            'runtime-install': 'The node\'s runtime could not be installed.',
            'node-ahead': 'The node runs a newer DSH than this desktop.',
            'node-unknown-version': 'The version installed on the node could not be read.',
            provision: 'The node\'s configuration could not be written.',
            'host-start': 'The resident service did not start.',
            'host-verify': 'The resident service started but did not answer the session probe.',
            unknown: 'This node could not be connected.',
          },
          actions: {
            'fix-credential': 'Edit credential',
            'review-host-key': 'Review host key',
            'check-network': 'Check the network',
            retry: 'Retry',
            'upgrade-node': 'Upgrade the node\'s Node.js',
            'upgrade-desktop': 'Upgrade this desktop',
            reinstall: 'Reinstall the runtime',
            'inspect-log': 'Open the connection log',
          },
          retrying: 'retrying',
          dropped: 'Disconnected, reconnecting',
          droppedAt: when => `Disconnected, reconnecting (since ${when})`,
          recovered: count => `Reconnected ${String(count)} time(s)`,
          /** Which rung of the ladder this is. Past the ladder it is a steady retry. */
          recoveryAttempt: (attempt, ladder) => (attempt <= ladder
            ? `Attempt ${String(attempt)}/${String(ladder)}`
            : 'retrying every 2 minutes'),
          /** How long the current phase has been running. */
          phasesElapsed: seconds => `${String(seconds)}s elapsed`,
          /** Live download progress; each fragment is dropped when its number is unknown. */
          transfer: ({ bytes, total, bytesPerSecond, etaMs }) => {
            const size = value => `${(value / 1048576).toFixed(1)} MiB`
            const parts = [total === undefined ? size(bytes) : `${size(bytes)} / ${size(total)}`]
            if (bytesPerSecond !== undefined) parts.push(`${(bytesPerSecond / 1048576).toFixed(1)} MB/s`)
            if (etaMs !== undefined) parts.push(`${String(Math.max(1, Math.round(etaMs / 1000)))}s left`)
            return parts.join(' · ')
          },
          /** The action verbs that are their own button, rather than "open the log". */
          resetHostKey: 'Reset host key',
          reprobe: 'Probe again',
          copyError: 'Copy error',
          errorCopied: 'Copied',
          reveal: 'Show',
          hide: 'Hide',
          hostKey: key => `Host key ${key}`,
          showLog: 'Connection log',
          logEmpty: 'Nothing logged yet.',
          copyLog: 'Copy',
          logCopied: 'Copied',
          logHint: 'The last 100 lines, with passwords, tokens and private keys removed.',
          plugins: 'Plugin sync',
          pluginsHint: 'These are the third-party plugins you installed into this desktop. They are sent by default: one installation, one working environment, rather than two machines that quietly differ. Switch one off and it stays on this machine only. The relay plugin and this plugin itself are never sent — a node that could manage other nodes, or that opened a second way in, is not what this is for. A change reaches connected nodes immediately and the node restarts its resident host when it has to.',
          pluginLoaded: 'loaded here',
          pluginInstalledOnly: 'installed here, not in this machine’s composition',
          pluginRows: rows => `${rows} row(s)`,
          pluginApplied: 'sent',
          pluginNodeFailed: 'the node did not take it',
          pluginNoNodes: 'No node is connected; the switch is remembered and applies on connect',
          pluginsNone: 'No third-party plugin is installed on this machine. Once one is, it is sent to nodes automatically and you can switch it off here.',
          pluginFailed: 'The plugin list is not composed yet',
          pickFolder: 'Choose a workspace folder',
          machine: 'On which machine',
          chooseDevice: 'Choose a device',
          thisDevice: 'This device',
          deviceHint: 'The machine the workspace lives on',
          switchDevice: 'Change',
          drivesHere: 'Drives',
          nodeRootHint: 'node root',
          browseAnywhere: 'Browse every folder',
          up: 'Up',
          go: 'Open',
          loading: 'Reading…',
          noFolders: 'No subfolders here.',
          noFoldersYet: 'This folder does not exist on that machine yet. Choosing it creates it there.',
          truncated: 'Showing the first 500 folders; type a full path above to go anywhere.',
          newFolder: 'New folder',
          newFolderTitle: 'New folder',
          newFolderName: 'Folder name',
          newFolderPlaceholder: 'e.g. my-project',
          newFolderCreate: 'Create',
          newFolderFailed: 'Could not create the folder',
          drives: 'Drives',
          workspaceName: 'Workspace name',
          workspaceNamePlaceholder: 'Leave empty to use the folder name',
          createProject: 'Create project',
          projectName: 'Project name',
          projectNamePlaceholder: 'New project',
          device: 'Device',
          addRemoteDevice: 'Add remote device…',
          sourceFolder: 'Source folder',
          chooseFolder: 'Choose a folder',
          lastUsed: 'Last used',
          chooseFolderHint: 'Harness can read and edit these folders',
          changeFolder: 'Change',
          pickThisFolder: 'Use this folder',
          back: 'Back',
          create: 'Create',
          existingOnDeviceHint: 'A project already on this device?',
          existingOnDeviceAction: 'Add to sidebar',
          existingEmpty: 'This device has no workspaces yet.',
        }

    /**
     * Token-driven styles, measured against the official settings pages rather than guessed.
     *
     * The values come from the shipped plugin-manager bundle
     * (`@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`, its `const css=` string),
     * which is the page the complaint compared this one to. Its rhythm: the page is a
     * `height:100%` column with `clamp(24px, 4vw, 48px)` side padding; the fixed head is
     * `28px` above the title and the body starts `32px` below it; the body is the one
     * scrolling child, with `gap:32px` between groups, `48px` under the last one, and every
     * child capped at `960px`. A row is not a hairline list item but a `card`: a `48px` icon
     * tile, a `14/20` 500-weight title, one `13/18` tertiary description line, an
     * `inline-flex` end slot, `2px` between cards and a hover fill as the only chrome. The
     * add button is `32px` tall on `--dsw-radius-md` at `13px`.
     *
     * Every variable named here is present in that bundle's token list — an
     * undefined `var()` silently renders as nothing, which is how a font-family token the
     * shipped sheet never defined produced an unexplained fallback font before.
     */
    const styles = {
      /**
       * The page is the official frame: a full-height column whose head is fixed and whose
       * body is the one scrolling child.
       *
       * That split is not decoration. The shell renders a `main` slot inside `mainPanel` →
       * `centerCol`, and `centerCol` is `overflow: hidden`, so a body taller than the frame
       * is **clipped with no scrollbar anywhere**: measured on a real page, `mainPanel` was
       * 1026 px tall with a 10658 px `scrollHeight`, and neither it nor any ancestor
       * scrolled. Giving the page the frame's height and letting `pageBody` scroll is the
       * only place this plugin can decide it — the shell's layout is not ours to change —
       * and it is exactly what the shipped plugin page does.
       */
      page: {
        boxSizing: 'border-box', height: '100%', minHeight: 0,
        padding: '0 clamp(24px, 4vw, 48px)',
        color: 'var(--dsw-alias-label-primary)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      },
      /**
       * The body bleeds back over the page's side padding so the scrollbar sits on the panel
       * edge rather than inside the text column; the padding then comes back as its own, so
       * every child still starts at the page inset. Copied from the official `.pageBody`,
       * whose `calc(100% + 2 * inset)` / `margin-inline: -inset` pair does the same, and its
       * `32px` top padding, which the official rule applies when the head is a sibling of the
       * body rather than the first child inside it — the shape this page uses.
       */
      pageBody: {
        boxSizing: 'border-box', flex: '1 1 auto', minHeight: 0,
        width: 'calc(100% + 2 * clamp(24px, 4vw, 48px))',
        marginInline: 'calc(-1 * clamp(24px, 4vw, 48px))',
        padding: '32px clamp(24px, 4vw, 48px) 48px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32,
        overflow: 'hidden auto',
      },
      /**
       * Every child of the scrolling column is capped at 960 px and centred. The official
       * rule is `.pageBody > *`; inline styles have no child selector, so the two kinds of
       * child — a group and the head — carry the cap themselves.
       */
      pageHead: {
        boxSizing: 'border-box', flex: 'none', width: '100%', maxWidth: 960, paddingTop: 28,
        display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between',
        alignItems: 'flex-start', gap: 16,
      },
      pageHeading: { minWidth: 0, maxWidth: '100%' },
      pageTitle: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px' },
      pageIntro: {
        color: 'var(--dsw-alias-label-secondary)',
        margin: '4px 0 0', fontSize: 13, lineHeight: '20px',
      },
      /**
       * The head's optional right-hand slot for page-level actions. It is `flex: 0 auto`
       * and never wraps its own label, so it shrinks to its content while the heading keeps
       * the leftover width — the opposite of the old group head, where the growing sibling
       * squeezed the title instead.
       */
      toolbar: {
        flex: '0 auto', minWidth: 0, whiteSpace: 'nowrap',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        justifyContent: 'flex-end', gap: '8px 16px',
      },

      // ---- group + card ---------------------------------------------------------
      //
      // The official list is not hairline rows: a group is a title line followed by cards,
      // and a card is an icon tile, a title, one description line and an end slot, with the
      // 2 px gap between cards and a rounded hover-free surface as the only chrome.
      group: { width: '100%', maxWidth: 960, display: 'flex', flexDirection: 'column', gap: 8 },
      groupHead: { display: 'flex', alignItems: 'center', gap: 8 },
      /**
       * `flex: 0 0 auto` + `nowrap` are the fix for the worst layout bug this page shipped:
       * with `flex: 1` and a growing hint beside it, the title was squeezed to a 23 px wide
       * column and its four characters stacked vertically. A group title never wraps.
       */
      groupTitle: {
        flex: '0 0 auto', margin: 0, fontSize: 14, fontWeight: 500, lineHeight: '22px',
        whiteSpace: 'nowrap',
      },
      /**
       * The hint yields instead: it takes the leftover width and ellipsises on one line.
       *
       * One line is what keeps the head at the official 22 px title height; a wrapping hint
       * is precisely what used to make the head 68 px tall and squeeze the title into a
       * vertical strip. The full sentence stays reachable through `title`.
       */
      groupHint: {
        flex: '1 1 auto', minWidth: 0, margin: 0,
        fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /**
       * A wrapping caption for the dialogs, where the text is the only content and clipping
       * it would hide an instruction. `groupHint` cannot do this job: it is single-line by
       * design, because inside a group head a wrapping hint is what used to squeeze the
       * title into a vertical strip.
       */
      hint: {
        margin: 0, fontSize: 12, lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      cards: {
        display: 'flex', flexDirection: 'column', gap: 2,
        margin: 0, padding: 0, listStyle: 'none',
      },
      /**
       * The negative inline margin is what lets the card's hover/press surface extend past
       * the text column without moving its content; `--dsw-radius-xl` is the official card
       * radius, and the card itself has no background and no border.
       */
      card: { borderRadius: 'var(--dsw-radius-xl)', minWidth: 0, margin: '0 -8px' },
      /** The official hover fill for an interactive card; the radius above exists for it. */
      cardHover: { background: 'var(--dsw-alias-interactive-bg-hover)' },
      cardHead: { display: 'flex', alignItems: 'center', gap: 14, padding: 8 },
      /** A 48 px tile is the official icon size; a bare glyph would read as a different row. */
      cardIcon: {
        width: 48, height: 48, flex: 'none',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-lg)',
        color: 'var(--dsw-alias-label-secondary)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      },
      cardMain: { display: 'flex', flexDirection: 'column', flex: 1, gap: 4, minWidth: 0 },
      cardTitle: {
        fontSize: 14, fontWeight: 500, lineHeight: '20px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      cardDesc: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 13, lineHeight: '18px',
        display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      cardEnd: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' },
      /**
       * Sub-content inside a card — a phase timeline, an expanded workspace list, an error.
       * The official `.card > .reason` indents by icon + gap + inset (8 + 48 + 14 = 70 px),
       * so anything hanging below a card lines up with the text it belongs to.
       */
      cardReason: { padding: '0 8px 8px 70px' },
      dot: size => ({ width: size ?? 8, height: size ?? 8, borderRadius: '50%', flex: '0 0 auto' }),
      name: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      grow: { flex: '1 1 auto', minWidth: 0 },
      /** A secret field and its reveal toggle on one line. */
      secretRow: { display: 'flex', alignItems: 'center', gap: 8 },
      /**
       * The official button height: 32 px on `--dsw-radius-md` at 13 px. The dialog's
       * secondary and primary buttons share it, so a dialog footer and the page's add
       * button are the same size — before this, page rows were 28 px while the shipped
       * add button was 32, which is exactly the "two designs" the complaint named.
       */
      button: {
        appearance: 'none', boxSizing: 'border-box', height: 32, padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 13,
        lineHeight: '20px', cursor: 'pointer', flex: '0 0 auto',
      },
      buttonPrimary: {
        appearance: 'none', boxSizing: 'border-box', height: 32, padding: '0 12px',
        border: '0.5px solid transparent', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)', fontSize: 13,
        lineHeight: '20px', cursor: 'pointer', flex: '0 0 auto',
      },
      buttonDanger: {
        appearance: 'none', boxSizing: 'border-box', height: 32, padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)',
        background: 'transparent', color: 'var(--dsw-alias-label-error)', fontSize: 13,
        lineHeight: '20px', cursor: 'pointer', flex: '0 0 auto',
      },
      buttonDisabled: { opacity: 0.4, cursor: 'default' },
      errorBar: {
        padding: '8px 10px', borderRadius: 'var(--dsw-radius-md)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-error)', fontSize: 12, lineHeight: '18px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      /** The classified-failure block: one sentence, one action, the detail behind a toggle. */
      failureHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      failureDetail: {
        marginTop: 6, fontSize: 11, lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      logBox: {
        marginTop: 6, maxHeight: 180, overflow: 'auto', padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-3)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
        lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        color: 'var(--dsw-alias-label-secondary)',
      },
      form: {
        display: 'flex', flexDirection: 'column', gap: 14, padding: 16,
        borderRadius: 'var(--dsw-radius-xl)', border: '0.5px solid var(--dsw-alias-border-l2)',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      input: {
        width: '100%', boxSizing: 'border-box', height: 34, padding: '0 12px', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 'var(--dsw-radius-md)',
        outline: 'none', fontFamily: 'inherit',
      },
      rowFields: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px', gap: 10 },
      actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
      link: {
        appearance: 'none', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
        fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
      },
      phases: { display: 'flex', flexDirection: 'column', gap: 4, padding: '0 0 6px' },
      phase: active => ({
        fontSize: 12, lineHeight: '18px',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        fontWeight: active ? 500 : 400,
      }),
      /**
       * The official `.empty` rule: no box, no padding, just the tertiary 13/20 line. The
       * surrounding group's 8 px gap and the dialog frame's padding already place it, and a
       * padded empty state here would shift every list that shows one.
       */
      empty: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      /**
       * A workspace line inside an expanded node card. No hairline: the official cards carry
       * their separation as a 2 px gap, and a rule here would draw a box the page does not
       * otherwise have.
       */
      workspaceRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' },
      addWorkspace: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 0 0' },
      mono: { fontFamily: 'var(--dsw-font-markdown-code-font-family)', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },

      // ---- dialog pieces ---------------------------------------------------------
      //
      // A 24 px square hit target for a glyph-only button, the way the shipped rows do it:
      // a bare icon at 16 px would be a 16 px click target.
      iconButton: {
        appearance: 'none', boxSizing: 'border-box', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', width: 24, height: 24,
        padding: 0, margin: 0, border: 'none', background: 'transparent',
        borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)', flex: 'none',
      },
      /** One machine (or one drive) per row, with a name and a second line of detail. */
      deviceRow: {
        appearance: 'none', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
        gap: 10, width: '100%', padding: '10px 2px', textAlign: 'left', cursor: 'pointer',
        border: 'none', borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        fontSize: 13, lineHeight: '20px',
      },
      deviceList: { display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' },
      /** The same frame the shipped pickers put their folder list in. */
      listFrame: {
        flex: '1 1 auto', minHeight: 120, maxHeight: 260, overflowY: 'auto',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', padding: 4,
      },
      /** The device picker on the form: a field-shaped button, not a `<select>`. */
      deviceButton: {
        appearance: 'none', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
        gap: 8, width: '100%', height: 34, padding: '0 10px', textAlign: 'left',
        cursor: 'pointer', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
      },
      deviceIcon: { display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-tertiary)' },
      /** A drive label: the same box as a small button, filled when it is the current root. */
      chip: active => ({
        appearance: 'none', boxSizing: 'border-box', height: 24, padding: '0 10px',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-sm)', cursor: 'pointer',
        fontSize: 12, lineHeight: '18px',
        color: active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        background: active === true ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
      }),
      /** The confirmed folder, boxed like an input so the form reads as one column. */
      folderChoice: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-3)',
      },
    }

    /** Fetch JSON from the plugin API, surfacing the server's routable error. */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      const body = text.length === 0 ? {} : JSON.parse(text)
      if (!response.ok || body.ok === false) {
        throw Object.assign(new Error(body.error ?? `HTTP ${String(response.status)}`), {
          code: body.code ?? 'rnh-failed',
        })
      }
      return body
    }

    const STATE_COLOR = {
      connected: 'var(--dsw-alias-state-success-primary)',
      connecting: 'var(--dsw-alias-brand-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    /**
     * How many rungs the Host's reconnect ladder has, for "attempt n of m".
     *
     * A copy of `RECOVERY_LADDER_MS.length` in `host/rnh.js`: the browser half cannot import
     * from the Host half (different bundles, different process), and a wrong number here
     * would be worse than a slightly stale one — so this is the only duplicated constant and
     * `client-bundle.mjs` checks that the two agree.
     */
    const RECOVERY_LADDER_LENGTH = 3

    function stateLabel(node) {
      if (node.state === 'connected') return T.connected
      if (node.state === 'connecting') return T.connecting
      if (node.state === 'failed') return T.failed
      return T.idle
    }

    /**
     * One phase timeline while a node connects.
     *
     * There is no separate "build" row and no per-route label any more: the runtime arrives
     * one way (a downloaded artefact), so the row that installs it is always the same row.
     * The `runtimeVia` prop is still read, because a node connected before build 4 carries a
     * stamp from the removed route and the settings page should name it rather than hide it.
     *
     * The clock beside the current step is the whole point of the row. A five-step timeline
     * with no time on it reads identically at two seconds and at four minutes, and those are
     * the two cases a person needs to tell apart. `phaseStartedAt` is the Host's own
     * timestamp, so the number survives a page reload mid-connect.
     */
    function PhaseList({ phase, runtimeVia, phaseStartedAt }) {
      const order = ['probe', 'install', 'provision', 'start', 'verify']
      const at = order.indexOf(phase ?? '')
      const label = id => (id === 'install' && runtimeVia === 'npm' ? T.phases.build : T.phases[id] ?? id)
      // Ticks once a second so the elapsed number is not frozen between the two-second polls.
      const [, setNow] = useState(Date.now())
      useEffect(() => {
        if (phaseStartedAt === undefined) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [phaseStartedAt])
      const elapsed = phaseStartedAt === undefined
        ? undefined
        : Math.max(0, Math.round((Date.now() - phaseStartedAt) / 1000))
      return h('div', { style: styles.phases },
        order.map((id, index) => h('div', { key: id, style: styles.phase(index === at) }, label(id))),
        elapsed === undefined ? null : h('span', { style: styles.meta }, T.phasesElapsed(elapsed)))
    }

    /**
     * The last folder a person picked on one device.
     *
     * Two functions rather than a module-level map so the storage key stays in one place, and
     * every read is defensive: `localStorage` throws in a private window on some browsers, and
     * a folder-picker that cannot remember a path must still open.
     */
    const LAST_DIR_KEY = 'dsh-remote-node-harness:last-dir:'

    /** Read the remembered folder for one device, or `undefined`. */
    function readLastDir(deviceId) {
      try {
        return window.localStorage?.getItem(`${LAST_DIR_KEY}${deviceId}`) ?? undefined
      } catch {
        return undefined
      }
    }

    /** Remember one device's folder. Failure is silent: this is a convenience, not state. */
    function rememberLastDir(deviceId, path) {
      try {
        window.localStorage?.setItem(`${LAST_DIR_KEY}${deviceId}`, path)
      } catch {
        // A browser that refuses storage keeps the dialog working, just without the shortcut.
      }
    }

    /**
     * The project form the shell asks for when a workspace is added.
     *
     * The shell's own picker browses **this** machine, so it can never name `/root/project`
     * on a node. This replaces that dialog with one that first asks *which machine* and
     * then browses that machine's folders — which is the whole point: adding a folder on a
     * node has to feel like adding a folder here.
     *
     * It fills the same slot the shipped pickers fill, so the gesture is unchanged: the
     * plus button next to Workspaces, or a new Session, opens it. Picking a path is the
     * main thing this does; creating the workspace is the shell's job, which is why the
     * answer is `onPicked(path)` and not an API call. A remote path is routed to its node
     * by the Host half, so one callback covers both cases.
     *
     * Three things go beyond naming a directory, all because the shell cannot do them:
     * a folder can be **created** here (a new project usually has no folder yet), a
     * workspace can be **named** here (the shell derives the title from the folder name),
     * and an existing folder on the node can be **adopted** without re-browsing to it.
     *
     * The first screen is the form — name, device, source folder — and the browser is a
     * second page it opens. That order matters: opening a file browser as the first thing
     * reads as "operate a folder dialog", while asking for a name first reads as "create a
     * project", which is the thing the person actually came to do.
     */
    function WorkspaceFolderFlow(props) {
      const open = props.open === true
      // One dialog, two entry points. A new Session is creating a project; the sidebar is
      // adding a workspace to a list. Same fields, different words — and the words are
      // what make the same form read correctly in both places.
      const asProject = props.origin === 'conversation.hero.workspace.directoryFlow'
        || props.origin === 'workspace.picker.directoryFlow'
      const [nodes, setNodes] = useState([])
      /** The chosen device: `''` is this machine, otherwise a node id. */
      const [deviceId, setDeviceId] = useState('')
      /** `form` | `device` | `roots` | `browse` | `existing` | `addNode` */
      const [page, setPage] = useState('form')
      const [title, setTitle] = useState('')
      /** The folder the person confirmed: `{ path, name }`, absent until they pick one. */
      const [chosen, setChosen] = useState(undefined)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(undefined)
      const [listing, setListing] = useState(undefined)
      const [loading, setLoading] = useState(false)
      const [typed, setTyped] = useState('')
      const [makingFolder, setMakingFolder] = useState(false)
      const [newName, setNewName] = useState('')
      const [newError, setNewError] = useState(undefined)
      /** Workspaces already on the selected device, while the "add to sidebar" page is up. */
      const [existing, setExisting] = useState(undefined)
      /** The chosen device's entry points: drive letters here, `/` plus the home there. */
      const [rootsInfo, setRootsInfo] = useState(undefined)
      const [rootsLoading, setRootsLoading] = useState(false)
      /** Where the browser should land when it opens: a drive here, `/` on a node. */
      const [pendingRoot, setPendingRoot] = useState('')
      /**
       * Where this device was last used.
       *
       * Most projects live in one place, and "open a workspace" is almost always "open the
       * same folder again". Remembered per device, because a path is meaningless on another
       * machine — `/root/project` on the desktop is nothing.
       *
       * In `localStorage` rather than on the Host: it is a per-window convenience with no
       * meaning outside this browser profile, and putting it in the registry would make every
       * node record carry a field only the UI reads.
       */
      const [lastDir, setLastDir] = useState(undefined)

      // Load the machine list when the dialog opens, not on mount: this component stays
      // mounted for the whole Session, and polling a node list that nobody is looking at
      // would be a request every two seconds for nothing.
      const reloadNodes = useCallback(async () => {
        try {
          const body = await api('/nodes')
          setNodes((body.nodes ?? []).filter(node => node.id !== undefined))
        } catch {
          // A node list that cannot be read must not block picking a local folder.
        }
      }, [])

      useEffect(() => {
        if (!open) return
        void reloadNodes()
      }, [open, reloadNodes])

      // The remembered folder for whichever device is selected. Read on every device change,
      // not once: the value is per device, and showing one machine's path beside another's
      // name would be worse than showing nothing.
      useEffect(() => {
        if (!open) return
        setLastDir(readLastDir(deviceId))
      }, [open, deviceId])

      const browse = useCallback(async (target, dir) => {
        setLoading(true)
        setError(undefined)
        try {
          const query = new URLSearchParams()
          if (target !== '') query.set('node', target)
          if (dir !== '') query.set('path', dir)
          const body = await api(`/browse?${query.toString()}`)
          setListing(body)
          setTyped('')
        } catch (failure) {
          setError(failure.message)
        } finally {
          setLoading(false)
        }
      }, [])

      // Opening the dialog starts on the form with nothing carried over, so a second visit
      // does not open on the folder the first visit happened to be looking at.
      useEffect(() => {
        if (!open) return
        setPage('form')
        setListing(undefined)
        setError(undefined)
        setMakingFolder(false)
        setNewName('')
        setNewError(undefined)
        setTitle('')
        setChosen(undefined)
        setExisting(undefined)
        setDeviceId('')
        setRootsInfo(undefined)
        setPendingRoot('')
      }, [open])

      // The entry points of the chosen device. This is the step that makes the two sides
      // symmetric: a person who said "this device" gets the drive letters, a person who
      // said a node gets that node's root — never a shared list of POSIX paths that would
      // only be right for one of them.
      useEffect(() => {
        if (!open || page !== 'roots') return
        let live = true
        setRootsInfo(undefined)
        setRootsLoading(true)
        const query = new URLSearchParams()
        if (deviceId !== '') query.set('node', deviceId)
        void api(`/browse?${query.toString()}`)
          .then(body => { if (live) setRootsInfo(body) })
          .catch(failure => { if (live) setError(failure.message) })
          .finally(() => { if (live) setRootsLoading(false) })
        return () => { live = false }
      }, [open, page, deviceId])

      // The browser lands where the device page pointed it: a drive root here, `/` on a
      // node, or that machine's home when the person went straight to browsing.
      useEffect(() => {
        if (!open || page !== 'browse') return
        setListing(undefined)
        void browse(deviceId, pendingRoot)
      }, [open, page, deviceId, pendingRoot, browse])

      if (!open) return null

      const current = listing?.path ?? ''
      const roots = listing?.roots ?? []

      /**
       * Commit the project form: name the workspace, then hand the folder to the shell.
       *
       * Without a name this is the cheap path the shell expects — it derives the title from
       * the folder name itself. With one, the workspace is created here first so the title
       * has somewhere to live; the shell then resolves that same row (create is
       * idempotent). A failure is reported in the form and nothing is handed over, because
       * a workspace that exists but is not selected looks like a lost click.
       */
      const commit = async () => {
        const folder = chosen?.path ?? ''
        if (folder.length === 0) return
        setError(undefined)
        setSaving(true)
        try {
          const wanted = title.trim()
          rememberLastDir(deviceId, folder)
          if (wanted.length === 0) {
            props.onPicked?.(folder)
            return
          }
          await api('/workspaces', {
            method: 'POST',
            body: JSON.stringify({
              ...(deviceId === '' ? {} : { nodeId: deviceId }),
              path: folder,
              title: wanted,
            }),
          })
          props.onPicked?.(folder)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSaving(false)
        }
      }

      const goTyped = event => {
        event.preventDefault()
        if (typed.trim().length === 0) return
        void browse(deviceId, typed.trim())
      }

      /** Create the folder being named, then stand inside it. */
      const createFolder = async event => {
        event.preventDefault()
        const name = newName.trim()
        if (name.length === 0 || current.length === 0) return
        setNewError(undefined)
        try {
          const body = await api('/browse', {
            method: 'POST',
            body: JSON.stringify({
              ...(deviceId === '' ? {} : { nodeId: deviceId }),
              path: current,
              name,
            }),
          })
          setMakingFolder(false)
          setNewName('')
          await browse(deviceId, body.path)
        } catch (failure) {
          setNewError(failure.message)
        }
      }

      /** List what the selected device already has, so an existing folder need not be found again. */
      const openExisting = async () => {
        if (deviceId === '') return
        setError(undefined)
        setPage('existing')
        setExisting(undefined)
        try {
          const body = await api('/workspaces')
          const prefix = `rnh_${deviceId}_`
          const items = body.baseline?.items ?? []
          setExisting(items.filter(item => typeof item.workspaceId === 'string'
            && item.workspaceId.startsWith(prefix)))
        } catch (failure) {
          setError(failure.message)
          setExisting([])
        }
      }

      /** The machine label a page names: this device, or the node's own name. */
      const deviceLabel = deviceId === ''
        ? T.thisDevice
        : (nodes.find(node => node.id === deviceId)?.name ?? deviceId)

      // The shipped modal, measured: the mask is the blur plus the mask colour, the card
// sits one layer above the page with the panel radius and the prominent elevation.
      // A 1000 z-index is what the shell's own dialogs use, so this dialog covers the
      // sidebar and the settings page alike.
      const overlay = {
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
        background: 'var(--dsw-alias-bg-mask-1)',
        backdropFilter: 'var(--dsw-mask-blur)',
      }
      const dialog = {
        boxSizing: 'border-box', position: 'relative',
        width: 'min(560px, 100%)', maxHeight: 'min(620px, calc(100vh - 72px))',
        display: 'flex', flexDirection: 'column', gap: 14, padding: 20,
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-panel)',
        boxShadow: 'var(--dsw-elevation-prominent)',
      }
      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', width: '100%',
        boxSizing: 'border-box', textAlign: 'left', cursor: 'pointer',
        appearance: 'none', background: 'transparent', border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        color: 'var(--dsw-alias-label-primary)', fontSize: 13,
      }
      // A native `<select>` keeps the platform's square frame no matter what the box
      // radius says, and a select cannot hold "add a device" as an option honestly — so
      // the device control is the field-shaped button in `styles.deviceButton` instead.
      /** The empty source-folder card: dashed, with the same wording the shipped form uses. */
      const folderSlot = {
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box',
        padding: '12px 14px', cursor: 'pointer', textAlign: 'left',
        appearance: 'none', borderRadius: 'var(--dsw-radius-md)', fontSize: 13,
        border: '1px dashed var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      }
      const title2 = asProject ? T.createProject : T.pickFolder
      const commitLabel = asProject ? T.create : T.addWorkspace

      const header = (heading, back) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        back === undefined
          ? null
          : h('button', {
              type: 'button',
              'aria-label': T.back,
              title: T.back,
              style: { ...styles.iconButton },
              onClick: back,
            }, h(IconChevronLeftOutlineRegular, { size: 16 })),
        h('h2', { style: { margin: 0, fontSize: 14, lineHeight: '22px', fontWeight: 500 } }, heading),
        h('button', {
          type: 'button',
          style: { ...styles.link, marginLeft: 'auto' },
          onClick: () => props.onCancel?.(),
        }, T.cancel))

      // ---- choose the device the folder lives on --------------------------------
      // This is the step the shipped picker cannot have: it browses this machine only, so
      // "where is the folder" has to be answered before "which folder". Each row is one
      // machine; its root directory is one page deeper.
      if (page === 'device') {
        const row = (key, label, hint, onPick, disabled) => h('button', {
          key,
          type: 'button',
          style: { ...styles.deviceRow, ...(disabled === true ? styles.buttonDisabled : {}) },
          disabled,
          onClick: onPick,
        },
        h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 16 })),
        h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { style: { fontSize: 13 } }, label),
          h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, hint)),
        deviceId === key
          ? h(IconChevronRightOutlineRegular, { size: 14, style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } })
          : null)

        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.chooseDevice },
          h('div', { style: dialog },
            header(T.chooseDevice, () => setPage('form')),
            h('p', { style: styles.hint }, T.deviceHint),
            h('div', { style: styles.deviceList },
              row('', T.thisDevice, T.drivesHere, () => { setDeviceId(''); setPage('roots') }, false),
              nodes.map(node => row(
                node.id,
                node.name,
                `${node.host} · ${T.nodeRootHint}`,
                () => { setDeviceId(node.id); setPage('roots') },
                false,
              ))),
            h('div', { style: { ...styles.actions, marginTop: 'auto' } },
              h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => setPage('addNode'),
              }, T.addRemoteDevice))))
      }

      // ---- one device's entry points: drive letters here, `/` on a node --------
      // The device page answers "which machine"; this page answers "where on that machine".
      // The answers differ by kind on purpose: this PC has drives, and a node's tree starts
      // at `/`. Showing a shared list of drive letters to a node — or POSIX paths to a
      // Windows machine — is exactly the mix-up the device step exists to prevent.
      if (page === 'roots') {
        const roots = rootsInfo?.roots ?? []
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.sourceFolder },
          h('div', { style: dialog },
            header(deviceLabel, () => setPage('device')),
            h('div', { style: styles.deviceList },
              // The last folder used on this device, first: reopening a project is the common
              // case, and reaching it through two more levels every time is the thing this
              // dialog was slow at. It is a shortcut, not a replacement — the roots stay below.
              lastDir === undefined || lastDir === ''
                ? null
                : h('button', {
                    type: 'button',
                    style: rowStyle,
                    title: lastDir,
                    onClick: () => { setChosen({ path: lastDir, name: lastDir.split(/[\\/]/u).filter(Boolean).at(-1) ?? lastDir }); setPage('form') },
                  },
                  h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 16 })),
                  h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    `${T.lastUsed} · ${lastDir}`)),
              rootsLoading
                ? h('div', { style: styles.empty }, T.loading)
                : roots.length === 0
                  ? h('div', { style: styles.empty }, T.noFolders)
                  : roots.map(root => h('button', {
                      key: root,
                      type: 'button',
                      style: rowStyle,
                      title: root,
                      onClick: () => {
                        setPendingRoot(root)
                        setPage('browse')
                      },
                    },
                    h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 16 })),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, root)))),
            h('div', { style: { ...styles.actions, marginTop: 'auto' } },
              h('button', { type: 'button', style: styles.button, onClick: () => setPage('device') }, T.switchDevice),
              h('button', {
                type: 'button',
                style: styles.buttonPrimary,
                disabled: rootsLoading,
                onClick: () => { setPendingRoot(''); setPage('browse') },
              }, T.browseAnywhere))))
      }

      // ---- adding a remote device, from inside the device list -----------------
      if (page === 'addNode') {
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.addRemoteDevice },
          h('div', { style: dialog },
            header(T.addRemoteDevice, () => setPage('device')),
            h(NodeForm, {
              onSubmit: async draft => {
                await api('/nodes', { method: 'POST', body: JSON.stringify(draft) })
                await reloadNodes()
                setPage('device')
              },
              onCancel: () => setPage('device'),
            })))
      }

      // ---- adopt a folder the node already has ---------------------------------
      if (page === 'existing') {
        const rows = existing ?? []
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.existingOnDeviceAction },
          h('div', { style: dialog },
            header(T.existingOnDeviceAction, () => setPage('form')),
            h('p', { style: styles.hint }, T.existingOnDeviceHint),
            h('div', { style: styles.listFrame },
              existing === undefined
                ? h('div', { style: styles.empty }, T.loading)
                : rows.length === 0
                  ? h('div', { style: styles.empty }, T.existingEmpty)
                  : rows.map(row => h('button', {
                      key: row.workspaceId,
                      type: 'button',
                      style: rowStyle,
                      title: row.path,
                      onClick: () => { props.onPicked?.(row.path) },
                    },
                    h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 16 })),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      row.title ?? row.path)))),
            error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,
            h('div', { style: { ...styles.actions, marginTop: 'auto' } },
              h('button', { type: 'button', style: styles.button, onClick: () => setPage('form') }, T.back))))
      }

      // ---- browse the chosen machine's folders ----------------------------------
      if (page === 'browse') {
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.chooseFolder },
          h('div', { style: dialog },
            header(`${deviceLabel} · ${T.chooseFolder}`, () => setPage('roots')),

            h('form', { style: { display: 'flex', gap: 8 }, onSubmit: goTyped },
              h('button', {
                type: 'button',
                style: { ...styles.button, flex: '0 0 auto' },
                disabled: listing?.parent === undefined || loading,
                onClick: () => { if (listing?.parent !== undefined) void browse(deviceId, listing.parent) },
              }, T.up),
              h('input', {
                style: { ...styles.input, flex: '1 1 auto', fontFamily: 'var(--dsw-font-markdown-code-font-family)', fontSize: 12 },
                placeholder: current.length === 0 ? T.pathPlaceholder : current,
                'aria-label': T.pathPlaceholder,
                value: typed,
                onChange: event => setTyped(event.target.value),
              }),
              h('button', { type: 'submit', style: { ...styles.button, flex: '0 0 auto' }, disabled: loading }, T.go)),

            // A drive is a root the home directory cannot reach: walking "up" from
            // `C:\Users\me` stops at `C:\`, so `D:\projects` needed a typed path. The
            // listing answers which roots exist, and they read as chips on one line.
            roots.length > 1
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', { style: styles.label }, T.drives),
                  roots.map(root => h('button', {
                    key: root,
                    type: 'button',
                    style: styles.chip(current === root),
                    'aria-pressed': current === root,
                    disabled: loading,
                    onClick: () => { void browse(deviceId, root) },
                  }, root)))
              : null,

            makingFolder
              ? h('form', {
                  style: { display: 'flex', gap: 8, alignItems: 'center' },
                  onSubmit: createFolder,
                },
                h('input', {
                  style: { ...styles.input, flex: '1 1 auto', fontSize: 12 },
                  placeholder: T.newFolderPlaceholder,
                  'aria-label': T.newFolderName,
                  value: newName,
                  autoFocus: true,
                  onChange: event => setNewName(event.target.value),
                }),
                h('button', {
                  type: 'submit',
                  style: { ...styles.buttonPrimary, ...(newName.trim().length === 0 ? styles.buttonDisabled : {}) },
                  disabled: newName.trim().length === 0,
                }, T.newFolderCreate),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  onClick: () => { setMakingFolder(false); setNewName(''); setNewError(undefined) },
                }, T.cancel))
              : h('div', { style: { display: 'flex', justifyContent: 'flex-start' } },
                  h('button', {
                    type: 'button',
                    style: { ...styles.button, display: 'inline-flex', alignItems: 'center', gap: 4 },
                    disabled: current.length === 0 || loading,
                    onClick: () => { setMakingFolder(true); setNewError(undefined) },
                  }, h(IconPlusOutlineRegular, { size: 14 }), T.newFolder)),

            newError !== undefined
              ? h('div', { style: { ...styles.errorBar, margin: 0 } }, `${T.newFolderFailed}: ${newError}`)
              : null,

            h('div', { style: styles.listFrame },
              loading
                ? h('div', { style: styles.empty }, T.loading)
                : (listing?.entries ?? []).length === 0
                  // An empty level on a node can mean "this folder is empty" or "this folder
                  // does not exist yet". The second is the only way to create a project on a
                  // node from the phone, so it has to be named rather than shown as "empty":
                  // confirming it is what creates it.
                  ? h('div', { style: styles.empty },
                      listing?.exists === false ? T.noFoldersYet : T.noFolders)
                  : (listing?.entries ?? []).map(entry => h('button', {
                      key: entry.path,
                      type: 'button',
                      style: rowStyle,
                      title: entry.path,
                      onClick: () => void browse(deviceId, entry.path),
                    },
                    h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 16 })),
                    entry.name))),

            listing?.truncated === true ? h('p', { style: styles.hint }, T.truncated) : null,

            error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,

            h('div', { style: { ...styles.actions, marginTop: 'auto' } },
              h('button', { type: 'button', style: styles.button, onClick: () => props.onCancel?.() }, T.cancel),
              h('button', {
                type: 'button',
                style: { ...styles.buttonPrimary, ...(current.length === 0 ? styles.buttonDisabled : {}) },
                disabled: current.length === 0 || loading,
                onClick: () => {
                  const leaf = current.split(/[\\/]/).filter(Boolean).pop() ?? current
                  setChosen({ path: current, name: leaf })
                  setPage('form')
                },
              }, T.pickThisFolder))))
      }

      // ---- the form itself: name → device → source folder -----------------------
      return h('div', { style: overlay, role: 'dialog', 'aria-label': title2 },
        h('div', { style: dialog },
          header(title2),

          h('label', { style: styles.field },
            h('span', { style: styles.label }, asProject ? T.projectName : T.workspaceName),
            h('input', {
              style: { ...styles.input, fontSize: 13 },
              placeholder: asProject ? T.projectNamePlaceholder : T.workspaceNamePlaceholder,
              value: title,
              onChange: event => setTitle(event.target.value),
            })),

          // Device next, folder last: that is the one extra decision a remote workspace
          // needs, and it is why the local picker could not do this job. The control is a
          // button, not a `<select>`: the device chooser is a page with a device list, and
          // a select cannot hold "add a device" as an option honestly.
          h('div', { style: styles.field },
            h('span', { style: styles.label }, asProject ? T.device : T.machine),
            h('button', {
              type: 'button',
              style: styles.deviceButton,
              disabled: saving,
              onClick: () => setPage('device'),
            },
            h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 16 })),
            h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, deviceLabel),
            h(IconChevronsUpDownOutlineRegular, { size: 14, style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } }))),

          // The shipped form offers this right under the device, only for a remote one: a
          // folder that already exists there should not have to be found again by hand.
          deviceId !== ''
            ? h('p', { style: styles.hint },
                T.existingOnDeviceHint, ' ',
                h('button', {
                  type: 'button',
                  style: styles.link,
                  onClick: () => { void openExisting() },
                }, T.existingOnDeviceAction))
            : null,

          h('div', { style: styles.field },
            h('span', { style: styles.label }, T.sourceFolder),
            chosen === undefined
              ? h('button', {
                  type: 'button',
                  style: folderSlot,
                  onClick: () => setPage('device'),
                },
                h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 18 })),
                h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: { fontWeight: 500 } }, T.chooseFolder),
                  h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, T.chooseFolderHint)))
              : h('div', { style: styles.folderChoice },
                h('span', { style: styles.deviceIcon, 'aria-hidden': true }, h(IconFolderCloseRegular, { size: 18 })),
                h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: { fontSize: 13 } }, chosen.name),
                  h('span', { style: { ...styles.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, chosen.path)),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  onClick: () => setPage('roots'),
                }, T.changeFolder))),

          error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,

          h('div', { style: { ...styles.actions, marginTop: 'auto' } },
            h('button', { type: 'button', style: styles.button, onClick: () => props.onCancel?.() }, T.cancel),
            h('button', {
              type: 'button',
              style: { ...styles.buttonPrimary, ...(chosen === undefined || saving ? styles.buttonDisabled : {}) },
              disabled: chosen === undefined || saving,
              onClick: () => { void commit() },
            }, commitLabel)),
        ))
    }

    /** Add one directory on a node as a workspace. */
    function AddWorkspace({ nodeId, onAdded }) {
      const [path, setPath] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const submit = async event => {
        event.preventDefault()
        if (path.trim().length === 0) return
        setBusy(true)
        setError(undefined)
        try {
          await api('/workspaces', { method: 'POST', body: JSON.stringify({ nodeId, path: path.trim() }) })
          setPath('')
          await onAdded()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }
      return h('form', { style: styles.addWorkspace, onSubmit: submit },
        h('input', {
          style: { ...styles.input, flex: '1 1 auto' },
          placeholder: T.pathPlaceholder,
          value: path,
          onChange: event => setPath(event.target.value),
        }),
        h('button', {
          type: 'submit',
          style: { ...styles.buttonPrimary, ...(busy ? styles.buttonDisabled : {}) },
          disabled: busy,
        }, T.addWorkspace),
        error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0, width: '100%' } }, error) : null)
    }

    /** The remote workspaces one node currently contributes. */
    function NodeWorkspaces({ nodeId, workspaces, onAdded }) {
      return h('div', null,
        workspaces.length === 0
          ? h('div', { style: styles.empty }, T.noWorkspaces)
          : workspaces.map(workspace => h('div', {
              key: workspace.workspaceId,
              style: styles.workspaceRow,
            },
            h('span', { style: { ...styles.dot(6), background: 'var(--dsw-alias-brand-primary)' }, 'aria-hidden': true }),
            h('div', { style: styles.grow },
              h('div', { style: styles.name }, workspace.title ?? workspace.path),
              h('div', { style: styles.mono }, workspace.path)))),
        h(AddWorkspace, { nodeId, onAdded }))
    }

    /**
     * An interactive card: the official `.cardLink` hover fill, done with state because an
     * inline style cannot express `:hover`.
     *
     * Only rows that hold their own controls are wrapped — a card that offers a decision
     * responds to the pointer, while a purely informational card (this machine) stays flat,
     * which is the same split the shipped page makes between `.card` and `.cardLink`.
     */
    function HoverCard({ children }) {
      const [hover, setHover] = useState(false)
      return h('li', {
        style: { ...styles.card, ...(hover ? styles.cardHover : {}) },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children)
    }

    /** One remote node row, as an official card: tile, title, one detail line, end actions. */
    function NodeRow({ node, workspaces, onAction, onEdit, onRefresh }) {
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [expanded, setExpanded] = useState(false)
      const connected = node.state === 'connected'
      const connecting = node.state === 'connecting'
      const run = async action => {
        setBusy(true)
        try {
          await onAction(node.id, action)
        } finally {
          setBusy(false)
        }
      }
      // The row is a card, not a hairline list item: the same 48 px tile / 14-20 title /
      // one-line tertiary detail / end-slot shape the shipped plugin cards use.
      return h(HoverCard, null,
        h('div', { style: styles.cardHead },
          h('span', { style: styles.cardIcon, 'aria-hidden': true }, h(PanelIcon, { size: 22 })),
          h('div', { style: styles.cardMain },
            h('div', { style: styles.cardTitle }, node.name),
            h('div', { style: styles.cardDesc },
              `${node.username}@${node.host}:${String(node.port)} · ${stateLabel(node)}`)),
          h('div', { style: styles.cardEnd },
            // The colour dot is the one piece kept from the old row: state is real
            // information, and the official `.statusWithDot` pairs a dot with its label
            // using the same `inline-flex` + 8 px gap shape, so it heads the end slot.
            h('span', {
              style: { ...styles.dot(8), background: STATE_COLOR[node.state] ?? STATE_COLOR.idle },
              'aria-hidden': true,
            }),
            connecting
              ? h('span', { style: styles.meta }, T.connecting)
              : connected
                ? h('button', {
                    type: 'button',
                    style: styles.button,
                    onClick: () => setExpanded(current => !current),
                  }, `${T.workspaces} (${String(workspaces.length)})`)
                : h('button', {
                    type: 'button',
                    style: { ...styles.button, ...(busy ? styles.buttonDisabled : {}) },
                    disabled: busy,
                    onClick: () => { run('connect').catch(() => undefined) },
                  }, node.state === 'failed' ? T.retry : T.connect),
            connected
              ? h('button', {
                  type: 'button',
                  style: { ...styles.button, ...(busy ? styles.buttonDisabled : {}) },
                  disabled: busy,
                  onClick: () => { run('disconnect').catch(() => undefined) },
                }, T.disconnect)
              : null,
            h('button', { type: 'button', style: styles.link, onClick: () => onEdit(node) }, T.edit),
            confirming
              ? null
              : h('button', { type: 'button', style: styles.link, onClick: () => setConfirming(true) }, T.remove))),
        // Everything that hangs below the head lines up with the text column, the way the
        // official `.card > .reason` indents past the icon instead of running full width.
        confirming
          ? h('div', { style: { ...styles.cardReason, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: styles.meta }, T.removeConfirm),
              h('button', {
                type: 'button',
                style: styles.buttonDanger,
                onClick: () => { onAction(node.id, 'remove').catch(() => undefined) },
              }, T.remove),
              h('button', { type: 'button', style: styles.link, onClick: () => setConfirming(false) }, T.cancel))
          : null,
        connecting && node.phase !== undefined
          ? h('div', { style: styles.cardReason },
              h(PhaseList, {
                phase: node.phase,
                runtimeVia: node.runtimeVia,
                phaseStartedAt: node.phaseStartedAt,
              }),
              // Bytes while the runtime archive arrives. Absent on every connect after the
              // first, because there is nothing left to download then.
              node.transfer === undefined
                ? null
                : h('div', { style: styles.meta }, T.transfer(node.transfer)))
          : null,
        // A dropped node is not a failure: nothing is wrong with the machine's configuration,
        // the socket went away and the ladder is bringing it back. Saying "已断线，正在重连" is
        // the honest state, and it is the one the sidebar's greyed rows agree with. The rung
        // is what turns "reconnecting" into "reconnecting, and this is the third try" — the
        // difference between waiting and going to look at the machine.
        node.state === 'idle' && node.droppedAt !== undefined
          ? h('div', { style: styles.cardReason },
              h('span', { style: styles.meta },
                node.droppedAt === undefined
                  ? T.dropped
                  : T.droppedAt(new Date(node.droppedAt).toLocaleTimeString())),
              node.recoveryAttempts === undefined
                ? null
                : h('span', { style: styles.meta },
                    ` · ${T.recoveryAttempt(node.recoveryAttempts, RECOVERY_LADDER_LENGTH)}`))
          : null,
        node.recoveries !== undefined && node.recoveries > 0
          ? h('div', { style: styles.cardReason },
              h('span', { style: styles.meta }, T.recovered(node.recoveries)))
          : null,
        // A node that built its own runtime says so on its own line: it is the one fact
        // that explains why this machine behaves differently from its neighbours, and it is
        // not something a person could infer from the version.
        connected && node.runtimeVia !== undefined && T.runtimeVia[node.runtimeVia] !== undefined
          ? h('div', { style: styles.cardReason, title: T.runtimeVia[node.runtimeVia] },
              h('span', { style: styles.meta }, T.runtimeVia[node.runtimeVia]))
          : null,
        connected && node.hostKey !== undefined
          ? h('div', { style: styles.cardReason, title: node.hostKey },
              h('span', { style: styles.meta }, T.hostKey(node.hostKey)))
          : null,
        expanded && connected
          ? h('div', { style: styles.cardReason },
              h(NodeWorkspaces, { nodeId: node.id, workspaces, onAdded: onAction === undefined ? undefined : onRefresh }))
          : null,
        node.error !== undefined
          ? h('div', { style: styles.cardReason },
              h(FailureBlock, {
                node,
                onAction: verb => { run(verb).catch(() => undefined) },
                onEdit,
                onResetHostKey: async target => {
                  // `hostKey: null` is what clears the record: `normalizeNode` keeps the field
                  // only when it is a non-empty string, so an explicit null drops it and the
                  // next connect records whatever the machine presents (TOFU again).
                  await onAction(target.id, 'forget-host-key').catch(() => undefined)
                  await run('connect').catch(() => undefined)
                },
              }))
          : null,
      )
    }

    /**
     * Why a connect failed, and the one thing to do about it.
     *
     * The Host classifies every failure into a code (`core/errors.js`) and sends
     * `{ code, message, action, retryable, detail }`. The sentence is localised here, and the
     * **action** decides which button appears — a wrong password does not get a Retry button,
     * because pressing it can only produce the same failure and read as "the app is broken".
     *
     * Every action in the table gets a control that does something. Two of them used to open
     * the log instead, which is the same as having no button: a person told "fix the
     * credential" and handed a hundred lines of redacted output has been told nothing.
     *
     * The English detail stays available behind a toggle rather than being the headline: it is
     * what a bug report needs, not what a person reads first.
     */
    function FailureBlock({ node, onAction, onEdit, onResetHostKey }) {
      const [open, setOpen] = useState(false)
      const [showLog, setShowLog] = useState(false)
      const [copied, setCopied] = useState(false)
      const failure = node.failure
      const sentence = failure === undefined
        ? T.errorTitle
        : T.failures[failure.code] ?? T.failures.unknown
      /**
       * What each action becomes. `undefined` means "there is nothing to press", and the
       * sentence plus the log is the honest answer — not a button that opens the same log.
       */
      const control = (() => {
        switch (failure?.action) {
          case 'retry':
            return { label: T.actions.retry, verb: 'connect', primary: true }
          case 'reinstall':
            return { label: T.actions.reinstall, verb: 'reinstall', primary: true }
          case 'check-network':
            // Re-runs the probe against the machine: reachability is exactly what it measures,
            // and it is cheaper and more specific than tearing the whole connect down again.
            return { label: T.reprobe, verb: 'probe', primary: true }
          case 'fix-credential':
            // Opens the form with the credential fields, which is the only place a person can
            // actually change what was refused.
            return { label: T.actions['fix-credential'], onPress: () => onEdit?.(node), primary: true }
          case 'review-host-key':
            // Forget the recorded key and connect again: that is what "review" has to mean in
            // a surface with no key-comparison dialog. The new key is recorded on success.
            return { label: T.resetHostKey, onPress: () => { void onResetHostKey?.(node) }, primary: true }
          default:
            return undefined
        }
      })()
      const retryAlso = failure?.retryable === true && control?.verb !== 'connect'
      const copyError = () => {
        const lines = [
          `${String(failure?.code ?? 'unknown')}: ${sentence}`,
          node.error ?? '',
          `node=${node.name} host=${node.host}:${String(node.port)}`,
        ].filter(line => line.length > 0)
        const write = navigator.clipboard?.writeText(lines.join('\n'))
        void write?.then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => undefined)
      }
      return h('div', { style: styles.errorBar },
        h('div', { style: styles.failureHead },
          h('strong', null, `${T.errorTitle}: `),
          h('span', null, sentence),
          control === undefined
            ? null
            : h('button', {
                type: 'button',
                style: control.primary === true ? styles.button : styles.link,
                onClick: () => {
                  if (control.onPress !== undefined) control.onPress()
                  else onAction(control.verb)
                },
              }, control.label),
          retryAlso
            ? h('button', { type: 'button', style: styles.link, onClick: () => onAction('connect') }, T.actions.retry)
            : null,
          h('button', { type: 'button', style: styles.link, onClick: copyError },
            copied ? T.errorCopied : T.copyError),
          h('button', {
            type: 'button',
            style: styles.link,
            onClick: () => setOpen(current => !current),
          }, open ? T.back : T.showLog)),
        open || showLog
          ? h(NodeLogPanel, { nodeId: node.id })
          : h('div', { style: styles.failureDetail }, node.error),
      )
    }

    /**
     * One node's last hundred lines.
     *
     * Fetched on open rather than carried in the node list: a hundred lines per node on every
     * two-second poll would be most of the traffic for a surface that is closed almost always.
     * The Host redacts on write, so what arrives here is already safe to copy.
     */
    function NodeLogPanel({ nodeId }) {
      const [text, setText] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        let cancelled = false
        api(`/nodes/${nodeId}/log`)
          .then(body => { if (!cancelled) setText(body.text ?? '') })
          .catch(failure => { if (!cancelled) setError(failure.message) })
        return () => { cancelled = true }
      }, [nodeId])
      const copy = () => {
        const write = navigator.clipboard?.writeText(text ?? '')
        void write?.then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }).catch(() => undefined)
      }
      return h('div', null,
        h('div', { style: { ...styles.failureHead, marginTop: 6 } },
          h('span', { style: styles.meta }, T.logHint),
          text === undefined || text === ''
            ? null
            : h('button', { type: 'button', style: styles.link, onClick: copy },
                copied ? T.logCopied : T.copyLog)),
        error !== undefined
          ? h('div', { style: styles.failureDetail }, error)
          : h('div', { style: styles.logBox }, text === undefined || text === '' ? T.logEmpty : text),
      )
    }

    /** The add/edit form for one node. */
    function NodeForm({ initial, onSubmit, onCancel }) {
      const seed = initial ?? {}
      const [draft, setDraft] = useState({
        name: seed.name ?? '',
        host: seed.host ?? '',
        port: String(seed.port ?? 22),
        username: seed.username ?? 'root',
        authKind: seed.authKind ?? 'password',
        password: '',
        privateKey: '',
        passphrase: '',
        remoteRoot: seed.remoteRoot ?? '~/.dsh-remote-node-harness',
        enabled: seed.enabled !== false,
      })
      const [submitting, setSubmitting] = useState(false)
      const [error, setError] = useState(undefined)
      // Which secret field is currently readable. Not persisted anywhere: a revealed field
      // closes with the form, so nothing stays on screen after the person moves on.
      const [reveal, setReveal] = useState({ password: false, passphrase: false })
      const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))

      const submit = async event => {
        event.preventDefault()
        setSubmitting(true)
        setError(undefined)
        try {
          const node = {
            name: draft.name.trim(),
            host: draft.host.trim(),
            port: Number(draft.port),
            username: draft.username.trim(),
            auth: { kind: draft.authKind },
            remoteRoot: draft.remoteRoot.trim(),
            enabled: draft.enabled,
            ...(initial?.id === undefined ? {} : { id: initial.id }),
            ...(draft.password.length > 0 ? { password: draft.password } : {}),
            ...(draft.privateKey.length > 0 ? { privateKey: draft.privateKey } : {}),
            ...(draft.passphrase.length > 0 ? { passphrase: draft.passphrase } : {}),
          }
          await onSubmit(node)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSubmitting(false)
        }
      }

      return h('form', { style: styles.form, onSubmit: submit },
        h('div', { style: styles.field },
          h('label', { style: styles.label }, T.name),
          h('input', {
            style: styles.input, value: draft.name, required: true,
            onChange: event => set('name', event.target.value),
          })),
        h('div', { style: styles.rowFields },
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.host),
            h('input', {
              style: styles.input, value: draft.host, required: true,
              onChange: event => set('host', event.target.value),
            })),
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.port),
            h('input', {
              style: styles.input, value: draft.port, inputMode: 'numeric',
              onChange: event => set('port', event.target.value),
            }))),
        h('div', { style: styles.rowFields },
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.username),
            h('input', {
              style: styles.input, value: draft.username, required: true,
              onChange: event => set('username', event.target.value),
            })),
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.auth),
            h('select', {
              style: styles.input, value: draft.authKind,
              onChange: event => set('authKind', event.target.value),
            },
            h('option', { value: 'password' }, T.password),
            h('option', { value: 'key' }, T.privateKey)))),
        draft.authKind === 'password'
          ? h('div', { style: styles.field },
              h('label', { style: styles.label }, T.password),
              h('div', { style: styles.secretRow },
                h('input', {
                  style: { ...styles.input, ...styles.grow },
                  type: reveal.password ? 'text' : 'password',
                  value: draft.password,
                  onChange: event => set('password', event.target.value),
                }),
                // A long generated password typed blind is the single most common way a
                // first connect fails, and the person then has no way to see what they
                // typed. The toggle reveals the field, not the stored value.
                h('button', {
                  type: 'button',
                  style: styles.link,
                  onClick: () => setReveal(current => ({ ...current, password: !current.password })),
                }, reveal.password ? T.hide : T.reveal)))
          : h(React.Fragment, null,
              h('div', { style: styles.field },
                h('label', { style: styles.label }, T.privateKey),
                h('textarea', {
                  style: { ...styles.input, minHeight: 120, fontFamily: 'ui-monospace, monospace', resize: 'vertical' },
                  value: draft.privateKey, placeholder: T.privateKeyHint,
                  onChange: event => set('privateKey', event.target.value),
                })),
              h('div', { style: styles.field },
                h('label', { style: styles.label }, T.passphrase),
                h('div', { style: styles.secretRow },
                  h('input', {
                    style: { ...styles.input, ...styles.grow },
                    type: reveal.passphrase ? 'text' : 'password',
                    value: draft.passphrase,
                    onChange: event => set('passphrase', event.target.value),
                  }),
                  h('button', {
                    type: 'button',
                    style: styles.link,
                    onClick: () => setReveal(current => ({ ...current, passphrase: !current.passphrase })),
                  }, reveal.passphrase ? T.hide : T.reveal)))),
        h('details', null,
          h('summary', { style: styles.link }, T.advanced),
          h('div', { style: { ...styles.field, marginTop: 10 } },
            h('label', { style: styles.label }, T.remoteRoot),
            h('input', {
              style: styles.input, value: draft.remoteRoot,
              onChange: event => set('remoteRoot', event.target.value),
            })),
          h('label', { style: { ...styles.label, display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 } },
            h('input', {
              type: 'checkbox', checked: draft.enabled,
              onChange: event => set('enabled', event.target.checked),
            }),
            T.autoConnect)),
        error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,
        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.button, onClick: onCancel }, T.cancel),
          h('button', {
            type: 'submit',
            style: { ...styles.buttonPrimary, ...(submitting ? styles.buttonDisabled : {}) },
            disabled: submitting,
          }, T.save)),
      )
    }

    /** Shared rnh state: one poll loop per mounted surface. */
    function useRnh() {
      const [state, setState] = useState({ loading: true, error: undefined, nodes: [], version: '', workspaces: [] })
      const timer = useRef()
      const load = useCallback(async () => {
        try {
          const [body, merged] = await Promise.all([api('/nodes'), api('/workspaces')])
          setState({
            loading: false,
            error: undefined,
            nodes: body.nodes ?? [],
            version: body.version ?? '',
            workspaces: merged.baseline?.items ?? [],
          })
        } catch (error) {
          setState(current => ({ ...current, loading: false, error: error.message }))
        }
      }, [])
      useEffect(() => {
        let cancelled = false
        const tick = async () => {
          if (cancelled) return
          await load()
          timer.current = setTimeout(tick, 2000)
        }
        tick()
        return () => {
          cancelled = true
          if (timer.current !== undefined) clearTimeout(timer.current)
        }
      }, [load])
      const action = useCallback(async (id, verb) => {
        if (verb === 'remove') await api(`/nodes/${id}`, { method: 'DELETE' })
        else await api(`/nodes/${id}/${verb}`, { method: 'POST' })
        await load()
      }, [load])
      const save = useCallback(async draft => {
        await api('/nodes', { method: 'POST', body: JSON.stringify(draft) })
        await load()
      }, [load])
      return { ...state, reload: load, action, save }
    }

    /** Workspaces belonging to one node, recognised by their wrapped identity. */
    function workspacesOf(all, nodeId) {
      const prefix = `rnh_${nodeId}_`
      return all.filter(workspace => typeof workspace.workspaceId === 'string'
        && workspace.workspaceId.startsWith(prefix))
    }

    /**
     * A neutral tile for a plugin that ships no icon.
     *
     * Drawn rather than typed: an emoji here renders as a coloured glyph that competes
     * with the real icons beside it, so a bundle without one looks like a different kind
     * of thing instead of an unlabelled one.
     */
    function PluginGlyph({ size }) {
      const edge = size ?? 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', { x: 3, y: 3, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 13, y: 3, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 3, y: 13, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 13, y: 13, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }))
    }

    /**
     * Per-plugin "send to nodes" switches — one row per plugin you installed.
     *
     * The row is a **bundle**, because that is the unit both sides understand: this
     * desktop's profile lists bundles, and a node composes a bundle list. An earlier
     * version listed every internal row this desktop composes (207 of them), which
     * described the composition instead of offering a decision — no one installs
     * `tool-result-pruner`, they install a plugin.
     *
     * Two facts per row: the switch (what a node loads) and where it is on this machine
     * (loaded, or merely downloaded). The second is what makes "off" honest rather than
     * looking like a mistake.
     */
    function PluginSyncSection() {
      const [rows, setRows] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [note, setNote] = useState(undefined)
      const [busy, setBusy] = useState(undefined)

      const load = useCallback(async () => {
        try {
          const body = await api('/plugins')
          setRows(body.rows ?? [])
          setError(undefined)
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const toggle = async row => {
        setBusy(row.bundle)
        setNote(undefined)
        try {
          const body = await api(`/plugins/${encodeURIComponent(row.bundle)}`, {
            method: 'POST',
            body: JSON.stringify({ sync: !row.sync }),
          })
          setRows(current => (current ?? []).map(entry => (entry.bundle === row.bundle ? body.row : entry)))
          setError(undefined)
          // The node's answer is the outcome, not the click: switching a plugin on installs
          // a package over SSH, and that can fail on the node's own registry. Reporting
          // "saved" while the node composes nothing is the bug this surface prevents.
          const reached = body.nodes ?? []
          const failed = reached.filter(report => report.error !== undefined
            || (report.plugins?.failed?.length ?? 0) > 0)
          if (failed.length > 0) {
            setError(failed.map(report => `${report.name}: ${report.error
              ?? report.plugins.failed.map(failure => `${failure.bundle} — ${failure.reason}`).join('; ')}`)
              .join('\n'))
          } else if (reached.length === 0) {
            setNote(T.pluginNoNodes)
          } else {
            setNote(`${T.pluginApplied}: ${reached.map(report => report.name).join(', ')}`)
          }
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(undefined)
        }
      }

      /**
       * One switch, drawn like the shipped toggle.
       *
       * This plugin cannot import another plugin's control, so the switch is local. The
       * values are copied from the shipped `._switch_` rule in the shell's stylesheet
       * (`index-CSAdOBx6.css`): 36×20 with 2 px padding, the thumb is `border-l3` when
       * off and the label-foreground colour when on, and the state is carried by
       * `aria-checked` the way that rule reads it.
       */
      const switchStyle = {
        boxSizing: 'border-box', position: 'relative', flex: '0 0 auto',
        width: 36, height: 20, padding: 2, border: 0, borderRadius: 999,
        appearance: 'none', cursor: 'pointer',
        background: 'var(--dsw-alias-border-l3)',
      }
      const switchOnStyle = { background: 'var(--dsw-alias-brand-primary)' }
      const thumbStyle = on => ({
        display: 'block', width: 16, height: 16, borderRadius: '50%',
        background: on ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-switch-thumb)',
        transition: 'transform .12s ease',
        transform: on ? 'translate(16px)' : 'none',
      })

      const detail = row => {
        const parts = []
        if (row.rows.length > 0) parts.push(T.pluginRows(row.rows.length))
        parts.push(row.loaded ? T.pluginLoaded : T.pluginInstalledOnly)
        return parts.join(' · ')
      }

      /**
       * The row's display text in the reader's language.
       *
       * The Host reads both dictionaries because it does not know which one this browser
       * wants; choosing here is what keeps the page from showing Chinese descriptions to
       * someone reading the English UI. Where a plugin ships only one language, that one
       * is shown — an untranslated sentence is more useful than a bare package name.
       */
      const metaText = row => {
        const meta = row.meta ?? {}
        const title = zh ? meta.title : (meta.titleEn ?? meta.title)
        const description = zh ? meta.description : (meta.descriptionEn ?? meta.description)
        return { title: title ?? row.bundle, description }
      }

      const rowNode = row => h(HoverCard, { key: row.bundle },
        h('div', { style: styles.cardHead },
          // The icon is the bundle's own, resolved the way DSH resolves it for its plugin
          // page; without one the row shows the neutral tile rather than a broken image.
          // Both live inside the 48 px tile so the row's height and rhythm are identical
          // whether or not the bundle ships artwork.
          row.meta?.icon === undefined
            ? h('span', { style: styles.cardIcon, 'aria-hidden': true }, h(PluginGlyph, { size: 22 }))
            : h('span', { style: styles.cardIcon },
                h('img', {
                  src: row.meta.icon,
                  alt: '',
                  style: { width: 32, height: 32, objectFit: 'contain', display: 'block' },
                })),
          h('div', { style: styles.cardMain },
            h('div', { style: styles.cardTitle }, metaText(row).title),
            // One description line is all the official card shows; the identity and the
            // local state go into the title attribute rather than a third line, so a long
            // description is clamped exactly like the shipped one instead of pushing the
            // switch out of the row's rhythm.
            h('div', {
              style: styles.cardDesc,
              title: metaText(row).description === undefined ? detail(row) : `${metaText(row).description} · ${detail(row)}`,
            }, metaText(row).description ?? `${row.bundle} · ${detail(row)}`)),
          h('div', { style: styles.cardEnd },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': row.sync === true,
              'aria-label': metaText(row).title,
              title: row.sync === true ? T.pluginOnHint : T.pluginOffHint,
              disabled: busy === row.bundle,
              style: {
                ...switchStyle,
                ...(row.sync === true ? switchOnStyle : {}),
                ...(busy === row.bundle ? { opacity: 0.5, cursor: 'default' } : {}),
              },
              onClick: () => { void toggle(row) },
            }, h('span', { style: thumbStyle(row.sync === true), 'aria-hidden': true })))))

      return h('section', { style: styles.group },
        h(GroupHead, { title: T.plugins, hint: T.pluginsHint }),
        error !== undefined
          ? h('div', { style: styles.errorBar }, error)
          : null,
        note !== undefined
          ? h('p', { style: styles.hint }, note)
          : null,
        rows === undefined
          ? h('div', { style: styles.empty }, T.pluginFailed)
          : rows.length === 0
            ? h('div', { style: styles.empty }, T.pluginsNone)
            : h('ul', { style: styles.cards }, rows.map(rowNode)),
      )
    }

    /**
     * The rnh groups, in the official skeleton: each is a `group` whose head carries a
     * title, a one-line hint and (for the remote group) the primary add button, followed by
     * `cards` — one `card` per machine or plugin.
     */
    function RnhBody() {
      const rnh = useRnh()
      const [editing, setEditing] = useState(undefined)
      const [search, setSearch] = useState('')
      const all = useMemo(() => rnh.nodes.filter(node => node.id !== undefined), [rnh.nodes])
      // Most recently connected first, then never-connected ones by name.
      //
      // The order a person wants is not alphabetical: with a handful of machines, the one they
      // are working on is the one that connected last. `lastConnectedAt` is recorded by the
      // registry on every successful connect, so this needs no extra state — and it survives a
      // restart, which a purely in-memory "recent" list would not.
      const remote = useMemo(() => {
        const needle = search.trim().toLowerCase()
        const filtered = needle === ''
          ? all
          : all.filter(node => `${node.name} ${node.username}@${node.host}:${String(node.port)}`
              .toLowerCase().includes(needle))
        return [...filtered].sort((left, right) => {
          const leftAt = left.lastConnectedAt ?? 0
          const rightAt = right.lastConnectedAt ?? 0
          if (leftAt !== rightAt) return rightAt - leftAt
          return String(left.name).localeCompare(String(right.name))
        })
      }, [all, search])
      // A fragment, not a wrapper: `pageBody` applies its `gap:32` to its children, so the
      // three groups have to be its direct children for the official rhythm to hold.
      return h(React.Fragment, null,
        h('section', { style: styles.group },
          h(GroupHead, { title: T.local, hint: T.localHint }),
          h('ul', { style: styles.cards },
            h('li', { style: styles.card },
              h('div', { style: styles.cardHead },
                h('span', { style: styles.cardIcon, 'aria-hidden': true }, h(PluginGlyph, { size: 22 })),
                h('div', { style: styles.cardMain },
                  h('div', { style: styles.cardTitle }, zh ? '本机 Harness' : 'This Harness'),
                  rnh.version === ''
                    ? null
                    : h('div', { style: styles.cardDesc }, `DSH ${rnh.version}`)),
                h('div', { style: styles.cardEnd },
                  // This machine is always running the Harness you are looking at, so the
                  // dot is the one status the page can state without asking the Host.
                  h('span', {
                    style: { ...styles.dot(8), background: 'var(--dsw-alias-state-success-primary)' },
                    'aria-hidden': true,
                  })))))),
        h('section', { style: styles.group },
          h(GroupHead, {
            title: T.remote,
            hint: T.remoteHint,
            action: h('button', {
              type: 'button',
              style: styles.buttonPrimary,
              onClick: () => setEditing({ next: true }),
            }, T.add),
          }),
          // A search box only once there is something to search: with two nodes it is a field
          // that costs more attention than it saves.
          all.length > 2
            ? h('div', { style: { padding: '0 8px 8px' } },
                h('input', {
                  style: styles.input,
                  value: search,
                  placeholder: T.searchNodes,
                  onChange: event => setSearch(event.target.value),
                }))
            : null,
          editing !== undefined && editing.next === true
            ? h(NodeForm, {
                onSubmit: async draft => {
                  await rnh.save(draft)
                  setEditing(undefined)
                },
                onCancel: () => setEditing(undefined),
              })
            : null,
          editing !== undefined && editing.next !== true
            ? h(NodeForm, {
                initial: editing,
                onSubmit: async draft => {
                  await rnh.save(draft)
                  setEditing(undefined)
                },
                onCancel: () => setEditing(undefined),
              })
            : null,
          remote.length === 0
            ? h('div', { style: styles.empty }, search.trim() === '' ? T.empty : T.searchEmpty)
            : h('ul', { style: styles.cards },
                remote.map(node => h(NodeRow, {
                  key: node.id,
                  node,
                  workspaces: workspacesOf(rnh.workspaces, node.id),
                  onAction: rnh.action,
                  onEdit: setEditing,
                  onRefresh: rnh.reload,
                }))),
          rnh.error !== undefined
            ? h('div', { style: styles.errorBar }, rnh.error)
            : null),
        remote.length > 0
          ? h('section', { style: styles.group },
              h(GroupHead, { title: T.workspaces, hint: T.workspacesHint }))
          : null,
        h(PluginSyncSection),
      )
    }

    /**
     * One group head: a title that never shrinks, a hint that yields, and an optional
     * right-hand action.
     *
     * The hint is single-line and ellipsised — that is what the official group head is, and
     * a wrapping hint is what used to squeeze the title into a 23 px vertical strip. The
     * full sentence stays reachable through `title`, so nothing is actually lost.
     */
    function GroupHead({ title, hint, action }) {
      return h('div', { style: styles.groupHead },
        h('h2', { style: styles.groupTitle }, title),
        h('p', { style: styles.groupHint, title: hint }, hint),
        action === undefined ? null : action)
    }

    /**
     * The official page skeleton, shared by the settings section and the panel page.
     *
     * `page` is the fixed frame, `pageHead` the title block that never scrolls, and
     * `pageBody` the single scrolling column — which is what makes these pages read like
     * the shipped plugin page rather than like a panel with its own padding. `toolbar` is
     * the optional right-hand slot the official head reserves for page-level actions.
     */
    function PageFrame({ title, intro, toolbar, children }) {
      return h('div', { style: styles.page },
        h('header', { style: styles.pageHead },
          h('div', { style: styles.pageHeading },
            h('h1', { style: styles.pageTitle }, title),
            h('p', { style: styles.pageIntro }, intro)),
          toolbar === undefined ? null : h('div', { style: styles.toolbar }, toolbar)),
        h('div', { style: styles.pageBody }, children))
    }

    /** Settings section page. */
    function SettingsSection() {
      return h(PageFrame, { title: T.sectionTitle, intro: T.subtitle },
        h(RnhBody))
    }

    /** Main-column panel page: the same skeleton, with this surface's own title. */
    function PanelPage() {
      return h(PageFrame, { title: T.title, intro: T.subtitle },
        h(RnhBody))
    }

    /** Sidebar panel icon: a console joined to a server. */
    function PanelIcon({ size, active }) {
      const edge = size ?? 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { display: 'block', opacity: active === false ? 0.7 : 1 },
      },
      h('rect', { x: 2, y: 5, width: 9, height: 6, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M2 15h9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { d: 'M11 8h3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('rect', { x: 15, y: 3, width: 7, height: 7, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 15, y: 14, width: 7, height: 7, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M14 7h1M14 17h1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The settings page lives on the section ledger, so the shipped shell
        // owns its navigation chrome and this plugin owns only the body.
        if (ctx.slots !== undefined) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-remote-node-harness',
            order: 40,
            label: () => T.sectionTitle,
          }, SettingsSection))

          // A sidebar panel icon plus its main-column page: connection management
          // is reachable without opening Settings. Remote workspaces themselves are
          // NOT shown here — they are merged into the ordinary sidebar by the Host.
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'rnh',
            order: 30,
            label: () => T.title,
          }, PanelIcon))
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'rnh',
          }, PanelPage))

          // Occupying the shell's folder-picker slots is what makes a remote folder
          // reachable at all: the shipped pickers browse this machine only, so they can
          // never name a directory on a node. Registering here replaces the dialog for
          // every entry point at once — the sidebar's plus button, the new-Session flow,
          // and the workspace picker — without touching any of them.
          //
          // The slot is named on the props rather than read from context: the two entry
          // points ask for the same fields under different words (a new Session creates a
          // **project**, the sidebar adds a **workspace**), and a component that cannot
          // tell which one opened it would have to say one of them wrongly.
          for (const slot of [
            'sidebar.workspaces.directoryFlow',
            'conversation.hero.workspace.directoryFlow',
            'workspace.picker.directoryFlow',
          ]) {
            ctx.slots.inject(slot, () => ctx.slots.register({ name: slot },
              props => h(WorkspaceFolderFlow, { ...props, origin: slot })))
          }
        }
      },
    }
  },
})
